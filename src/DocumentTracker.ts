'use strict';
import { Functions, IDeferrable } from './system';
import { Disposable, Event, EventEmitter, TextDocument, TextDocumentChangeEvent, TextEditor, Uri, window, workspace } from 'vscode';
import { Git } from './git/git';
import { Logger } from './logger';

export interface DocumentState {
    hasErrors: boolean;
}

export class TrackedDocument<T extends DocumentState> {

    state: T | undefined;
    private _shouldTriggerOnNextChange: boolean = false;

    constructor(
        public readonly key: string,
        public dirty: boolean
    ) { }

    get shouldTriggerOnNextChange() {
        return this._shouldTriggerOnNextChange;
    }

    triggerOnNextChange() {
        this._shouldTriggerOnNextChange = true;
    }

    clearTriggerOnNextChange() {
        this._shouldTriggerOnNextChange = false;
    }
}

export class DocumentDirtyStateChangeEvent {

    constructor(
        public readonly document: TextDocument,
        public readonly dirty: boolean
    ) { }
}

export class DocumentTracker<T extends DocumentState> extends Disposable {

    private _onDidDirtyStateChange = new EventEmitter<DocumentDirtyStateChangeEvent>();
    get onDidDirtyStateChange(): Event<DocumentDirtyStateChangeEvent> {
        return this._onDidDirtyStateChange.event;
    }

    private _disposable: Disposable | undefined;
    private readonly _documentMap: Map<TextDocument | string, TrackedDocument<T>> = new Map();

    constructor() {
        super(() => this.dispose());

        this._disposable = Disposable.from(
            workspace.onDidChangeTextDocument(Functions.debounce(this.onTextDocumentChanged, 50), this),
            workspace.onDidCloseTextDocument(this.onTextDocumentClosed, this)
        );
    }

    dispose() {
        this.stop();
    }

    start() {
        if (this._disposable !== undefined) {
            this.stop();
        }

        this._disposable = Disposable.from(
            workspace.onDidChangeTextDocument(Functions.debounce(this.onTextDocumentChanged, 50), this),
            workspace.onDidCloseTextDocument(this.onTextDocumentClosed, this)
        );
    }

    stop() {
        if (this._disposable !== undefined) {
            this._disposable.dispose();
            this._disposable = undefined;
        }

        this._documentMap.clear();
    }

    async add(fileName: string): Promise<TrackedDocument<T>>;
    async add(document: TextDocument): Promise<TrackedDocument<T>>;
    async add(uri: Uri): Promise<TrackedDocument<T>>;
    async add(documentOrId: string | TextDocument | Uri): Promise<TrackedDocument<T>> {
        if (typeof documentOrId === 'string') {
            documentOrId = await workspace.openTextDocument(documentOrId);
        }
        else if (documentOrId instanceof Uri) {
            documentOrId = await workspace.openTextDocument(documentOrId);
        }

        return this.addCore(documentOrId);
    }

    private addCore(document: TextDocument): TrackedDocument<T> {
        const key = this.toKey(document.uri);

        // Always start out false, so we will fire the event if needed
        const entry = new TrackedDocument<T>(key, false);
        this._documentMap.set(document, entry);
        this._documentMap.set(key, entry);

        return entry;
    }

    clear(stateOnly: boolean = false) {
        if (!stateOnly) {
            this._documentMap.clear();

            return;
        }

        for (const d of this._documentMap.values()) {
            d.state = undefined;
        }
    }

    get(fileName: string): TrackedDocument<T> | undefined;
    get(document: TextDocument): TrackedDocument<T> | undefined;
    get(uri: Uri): TrackedDocument<T> | undefined;
    get(key: string | TextDocument | Uri): TrackedDocument<T> | undefined {
        if (typeof key === 'string' || key instanceof Uri) {
            key = this.toKey(key);
        }
        return this._documentMap.get(key);
    }

    private toKey(fileName: string): string;
    private toKey(uri: Uri): string;
    private toKey(fileNameOrUri: string | Uri): string;
    private toKey(fileNameOrUri: string | Uri): string {
        return Git.normalizePath(typeof fileNameOrUri === 'string' ? fileNameOrUri : fileNameOrUri.fsPath).toLowerCase();
    }

    private onTextDocumentChanged(e: TextDocumentChangeEvent) {
        if (e.document.uri.scheme !== 'file') return;

        let doc = this._documentMap.get(e.document);
        if (doc === undefined) {
            doc = this.addCore(e.document);
        }

        // Don't remove broken blame on change (since otherwise we'll have to run the broken blame again)
        if (doc.state !== undefined && !doc.state.hasErrors) {
            Logger.log(`Clear state for '${doc.key}', reason=DocumentChanged`);
            doc.state = undefined;
        }

        if (doc.shouldTriggerOnNextChange) {
            doc.clearTriggerOnNextChange();
        }
        else {
            if (doc.dirty === e.document.isDirty) return;

            doc.dirty = !doc.dirty;
        }

        // Only fire state change events for the active document
        const editor = window.activeTextEditor;
        if (editor === undefined || editor.document !== e.document) return;

        this.fireDocumentDirtyStateChanged(editor, new DocumentDirtyStateChangeEvent(e.document, doc.dirty));
    }

    private _dirtyStateChangedDebounced: ((editor: TextEditor, e: DocumentDirtyStateChangeEvent) => void) & IDeferrable;
    private fireDocumentDirtyStateChanged(editor: TextEditor, e: DocumentDirtyStateChangeEvent) {
        Logger.log('DocumentTracker.fireDirtyStateChanged', e.document.uri.toString(), e.dirty);

        if (e.dirty) {
            setImmediate(() => {
                if (this._dirtyStateChangedDebounced !== undefined) {
                    this._dirtyStateChangedDebounced.cancel();
                }

                if (window.activeTextEditor !== editor) return;

                this._onDidDirtyStateChange.fire(e);
            });

            return;
        }

        if (this._dirtyStateChangedDebounced === undefined) {
            this._dirtyStateChangedDebounced = Functions.debounce((editor: TextEditor, e: DocumentDirtyStateChangeEvent) => {
                if (window.activeTextEditor !== editor) return;

                this._onDidDirtyStateChange.fire(e);
            }, 250);
        }

        this._dirtyStateChangedDebounced(editor, e);
    }

    private onTextDocumentClosed(document: TextDocument) {
        if (document.uri.scheme !== 'file') return;

        if (this._documentMap.delete(document)) {
            const key = this.toKey(document.uri);
            Logger.log(`Clear state for '${key}', reason=DocumentClosed`);
            this._documentMap.delete(key);
        }
    }
}
