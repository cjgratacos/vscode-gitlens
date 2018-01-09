'use strict';
import { Functions, IDeferrable, Strings } from './system';
import { ConfigurationChangeEvent, Disposable, Event, EventEmitter, TextDocument, TextDocumentChangeEvent, TextEditor, Uri, window, workspace } from 'vscode';
import { configuration } from './configuration';
import { CommandContext, isTextEditor, setCommandContext } from './constants';
import { Logger } from './logger';
import { DocumentBlameStateChangeEvent, TrackedDocument } from './trackedDocument';

export * from './gitDocumentState';
export * from './trackedDocument';

export interface DocumentDirtyStateChangeEvent {

    readonly document: TextDocument;
    readonly dirty: boolean;
}

export class DocumentStateTracker<T> extends Disposable {

    private _onDidChangeBlameState = new EventEmitter<DocumentBlameStateChangeEvent>();
    get onDidChangeBlameState(): Event<DocumentBlameStateChangeEvent> {
        return this._onDidChangeBlameState.event;
    }

    private _onDidChangeDirtyState = new EventEmitter<DocumentDirtyStateChangeEvent>();
    get onDidChangeDirtyState(): Event<DocumentDirtyStateChangeEvent> {
        return this._onDidChangeDirtyState.event;
    }

    private readonly _disposable: Disposable | undefined;
    private readonly _documentMap: Map<TextDocument | string, TrackedDocument<T>> = new Map();

    constructor() {
        super(() => this.dispose());

        this._disposable = Disposable.from(
            configuration.onDidChange(this.onConfigurationChanged, this),
            window.onDidChangeActiveTextEditor(Functions.debounce(this.onActiveTextEditorChanged, 0), this),
            workspace.onDidChangeTextDocument(Functions.debounce(this.onTextDocumentChanged, 50), this),
            workspace.onDidCloseTextDocument(this.onTextDocumentClosed, this)
        );
    }

    dispose() {
        this._disposable && this._disposable.dispose();

        this.clear();
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
        const key = DocumentStateTracker.toStateKey(document.uri);

        // Always start out false, so we will fire the event if needed
        const doc = new TrackedDocument<T>(document, key, false, { onDidBlameStateChange: (e: DocumentBlameStateChangeEvent) => this._onDidChangeBlameState.fire(e) });
        this._documentMap.set(document, doc);
        this._documentMap.set(key, doc);

        return doc;
    }

    clear() {
        for (const d of this._documentMap.values()) {
            d.dispose();
        }

        this._documentMap.clear();
    }

    get(fileName: string): TrackedDocument<T> | undefined;
    get(document: TextDocument): TrackedDocument<T> | undefined;
    get(uri: Uri): TrackedDocument<T> | undefined;
    get(key: string | TextDocument | Uri): TrackedDocument<T> | undefined {
        if (typeof key === 'string' || key instanceof Uri) {
            key = DocumentStateTracker.toStateKey(key);
        }
        return this._documentMap.get(key);
    }

    has(fileName: string): boolean;
    has(document: TextDocument): boolean;
    has(uri: Uri): boolean;
    has(key: string | TextDocument | Uri): boolean {
        if (typeof key === 'string' || key instanceof Uri) {
            key = DocumentStateTracker.toStateKey(key);
        }
        return this._documentMap.has(key);
    }

    private onConfigurationChanged(e: ConfigurationChangeEvent) {
        const initializing = configuration.initializing(e);

        // Only rest the cached state if we aren't initializing
        if (!initializing && (configuration.changed(e, configuration.name('blame')('ignoreWhitespace').value, null) ||
            configuration.changed(e, configuration.name('advanced')('caching')('enabled').value))) {
            for (const d of this._documentMap.values()) {
                d.reset('config');
            }
        }
    }

    private onActiveTextEditorChanged(editor: TextEditor | undefined) {
        if (editor !== undefined && !isTextEditor(editor)) return;

        if (editor === undefined) {
            setCommandContext(CommandContext.ActiveIsRevision, false);
            setCommandContext(CommandContext.ActiveFileIsTracked, false);
            setCommandContext(CommandContext.ActiveIsBlameable, false);
            setCommandContext(CommandContext.ActiveHasRemote, false);

            return;
        }

        const doc = this._documentMap.get(editor.document);
        if (doc !== undefined) {
            doc.activate();

            return;
        }

        // No need to activate this, as it is implicit in initialization if currently active
        this.addCore(editor.document);
    }

    private onTextDocumentChanged(e: TextDocumentChangeEvent) {
        if (e.document.uri.scheme !== 'file') return;

        let doc = this._documentMap.get(e.document);
        if (doc === undefined) {
            doc = this.addCore(e.document);
        }

        doc.reset('document');

        if (doc.shouldTriggerOnNextChange) {
            doc.resetTriggerOnNextChange();
        }
        else {
            if (doc.dirty === e.document.isDirty) return;

            doc.dirty = !doc.dirty;
        }

        // Only fire state change events for the active document
        const editor = window.activeTextEditor;
        if (editor === undefined || editor.document !== e.document) return;

        this.fireDocumentDirtyStateChanged(editor, { document: e.document, dirty: doc.dirty } as DocumentDirtyStateChangeEvent);
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

                this._onDidChangeDirtyState.fire(e);
            });

            return;
        }

        if (this._dirtyStateChangedDebounced === undefined) {
            this._dirtyStateChangedDebounced = Functions.debounce((editor: TextEditor, e: DocumentDirtyStateChangeEvent) => {
                if (window.activeTextEditor !== editor) return;

                this._onDidChangeDirtyState.fire(e);
            }, 250);
        }

        this._dirtyStateChangedDebounced(editor, e);
    }

    private onTextDocumentClosed(document: TextDocument) {
        const doc = this._documentMap.get(document);
        if (doc === undefined) return;

        doc.dispose();
        this._documentMap.delete(document);
        this._documentMap.delete(doc.key);
    }

    static toStateKey(fileName: string): string;
    static toStateKey(uri: Uri): string;
    static toStateKey(fileNameOrUri: string | Uri): string;
    static toStateKey(fileNameOrUri: string | Uri): string {
        return Strings.normalizePath(typeof fileNameOrUri === 'string' ? fileNameOrUri : fileNameOrUri.fsPath).toLowerCase();
    }
}
