'use strict';
import { Functions, IDeferrable } from './system';
import { ConfigurationChangeEvent, Disposable, Event, EventEmitter, TextDocument, TextDocumentChangeEvent, TextEditor, Uri, window, workspace } from 'vscode';
import { configuration } from './configuration';
import { CommandContext, isTextEditor, setCommandContext } from './constants';
import { GitService, GitUri, Repository, RepositoryChange, RepositoryChangeEvent } from './gitService';
import { Logger } from './logger';

export interface DocumentState {
    hasErrors: boolean;
}

export class TrackedDocument<T extends DocumentState> extends Disposable {

    state: T | undefined;

    private _disposable: Disposable;
    private _disposed: boolean = false;
    private _repo: (Repository | undefined) | Promise<Repository | undefined>;
    private _uri: GitUri | undefined;

    constructor(
        public readonly document: TextDocument,
        public readonly key: string,
        public dirty: boolean
    ) {
        super(() => this.dispose());

        this._repo = this.initialize(document.uri);
    }

    dispose() {
        this._disposed = true;
        this._disposable && this._disposable.dispose();
    }

    private async initialize(uri: Uri) {
        this._uri = await GitUri.fromUri(uri, GitService.instance);
        if (this._disposed) return;

        const repo = await GitService.instance.getRepository(this._uri);
        if (this._disposed) return;

        this._repo = repo;

        if (repo !== undefined) {
            this._disposable = repo.onDidChange(this.onRepositoryChanged, this);
        }

        this.update();

        return repo;
    }

    private onRepositoryChanged(e: RepositoryChangeEvent) {
        if (!e.changed(RepositoryChange.Repository)) return;

        // Reset any cached state
        this.clear();
        this.update();
    }

    clear() {
        this.state = undefined;
    }

    private async update() {
        if (this._disposed || this._uri === undefined) {
            this._hasRemotes = false;
            this._isRevision = false;
            this._isTracked = false;

            return;
        }

        const editor = window.activeTextEditor;
        const isActive = editor !== undefined && editor.document === this.document;

        this._isRevision = !!this._uri.sha;
        if (isActive) {
            setCommandContext(CommandContext.ActiveIsRevision, this._isRevision);
        }

        this._isTracked = await GitService.instance.isTracked(this._uri);
        if (isActive) {
            setCommandContext(CommandContext.ActiveFileIsTracked, this._isTracked);
            setCommandContext(CommandContext.ActiveIsBlameable, this._isTracked);
        }

        let repo = undefined;
        if (this._isTracked) {
            repo = await this._repo;
        }

        if (repo !== undefined) {
            this._hasRemotes = await repo.hasRemote();
        }
        else {
            this._hasRemotes = false;
        }

        if (isActive) {
            setCommandContext(CommandContext.ActiveHasRemote, this._hasRemotes);
        }
    }

    private _hasRemotes: boolean = false;
    get hasRemotes() {
        return this._hasRemotes;
    }

    private _isRevision: boolean = false;
    get isRevision() {
        return this._isRevision;
    }

    private _isTracked: boolean = false;
    get isTracked() {
        return this._isTracked;
    }

    private _shouldTriggerOnNextChange: boolean = false;
    get shouldTriggerOnNextChange() {
        return this._shouldTriggerOnNextChange;
    }

    activate() {
        setCommandContext(CommandContext.ActiveIsRevision, this._isRevision);
        setCommandContext(CommandContext.ActiveFileIsTracked, this._isTracked);
        setCommandContext(CommandContext.ActiveIsBlameable, this._isTracked);
        setCommandContext(CommandContext.ActiveHasRemote, this._hasRemotes);
    }

    getRepository() {
        return this._repo;
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

export class DocumentStateTracker<T extends DocumentState> extends Disposable {

    private _onDidDirtyStateChange = new EventEmitter<DocumentDirtyStateChangeEvent>();
    get onDidDirtyStateChange(): Event<DocumentDirtyStateChangeEvent> {
        return this._onDidDirtyStateChange.event;
    }

    private _disposable: Disposable | undefined;
    private readonly _documentMap: Map<TextDocument | string, TrackedDocument<T>> = new Map();

    constructor() {
        super(() => this.dispose());
    }

    dispose() {
        this.stop();
    }

    start() {
        if (this._disposable !== undefined) {
            this.stop();
        }

        this._disposable = Disposable.from(
            configuration.onDidChange(this.onConfigurationChanged, this),
            window.onDidChangeActiveTextEditor(Functions.debounce(this.onActiveTextEditorChanged, 0), this),
            workspace.onDidChangeTextDocument(Functions.debounce(this.onTextDocumentChanged, 50), this),
            workspace.onDidCloseTextDocument(this.onTextDocumentClosed, this)
        );
    }

    stop() {
        if (this._disposable !== undefined) {
            this._disposable.dispose();
            this._disposable = undefined;
        }

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
        const key = this.toKey(document.uri);

        // Always start out false, so we will fire the event if needed
        const doc = new TrackedDocument<T>(document, key, false);
        this._documentMap.set(document, doc);
        this._documentMap.set(key, doc);

        return doc;
    }

    clear() {
        this._documentMap.clear();
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
        return GitService.normalizePath(typeof fileNameOrUri === 'string' ? fileNameOrUri : fileNameOrUri.fsPath).toLowerCase();
    }

    private onConfigurationChanged(e: ConfigurationChangeEvent) {
        const initializing = configuration.initializing(e);

        // Only rest the cached state if we aren't initializing
        if (!initializing && configuration.changed(e, configuration.name('blame')('ignoreWhitespace').value, null)) {
            for (const d of this._documentMap.values()) {
                d.clear();
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

        // No need to activate this, as it is implicit in initialization if active
        this.addCore(editor.document);
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
