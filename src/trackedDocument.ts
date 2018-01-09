'use strict';
import { Disposable, Event, EventEmitter, TextDocument, Uri, window } from 'vscode';
import { CommandContext, setCommandContext } from './constants';
import { Container } from './container';
import { GitUri, Repository, RepositoryChange, RepositoryChangeEvent } from './gitService';
import { Logger } from './logger';

export interface DocumentBlameStateChangeEvent {
    readonly document: TextDocument;
    readonly blameable: boolean;
}

export class TrackedDocument<T> extends Disposable {

    private _onDidBlameStateChange = new EventEmitter<DocumentBlameStateChangeEvent>();
    get onDidBlameStateChange(): Event<DocumentBlameStateChangeEvent> {
        return this._onDidBlameStateChange.event;
    }

    state: T | undefined;

    private _disposable: Disposable;
    private _disposed: boolean = false;
    private _repo: (Repository | undefined) | Promise<Repository | undefined>;
    private _uri: GitUri;

    constructor(
        public readonly document: TextDocument,
        public readonly key: string,
        public dirty: boolean,
        private _eventDelegates: { onDidBlameStateChange: (e: DocumentBlameStateChangeEvent) => void }
    ) {
        super(() => this.dispose());

        this._repo = this.initialize(document.uri);
    }

    dispose() {
        this._disposed = true;
        this.reset('dispose');
        this._disposable && this._disposable.dispose();
    }

    private async initialize(uri: Uri) {
        this._uri = await GitUri.fromUri(uri, Container.git);
        if (this._disposed) return;

        const repo = await Container.git.getRepository(this._uri);
        if (this._disposed) return;

        this._repo = repo;

        if (repo !== undefined) {
            this._disposable = repo.onDidChange(this.onRepositoryChanged, this);
        }

        this.update({ initializing: true });

        return repo;
    }

    private onRepositoryChanged(e: RepositoryChangeEvent) {
        if (!e.changed(RepositoryChange.Repository)) return;

        // Reset any cached state
        this.reset('repository');
        this.update();
    }

    private _blameFailed: boolean = false;
    setBlameFailure() {
        const wasBlameable = this.isBlameable;

        this._blameFailed = true;

        if (wasBlameable && this.isActive()) {
            this.update({ forceBlameChange: true});
        }
    }

    reset(reason: 'config' | 'dispose' | 'document' | 'repository') {
        this._blameFailed = false;

        if (this.state === undefined) return;

        // // Don't remove broken blame on change (since otherwise we'll have to run the broken blame again)
        // if (!this.state.hasErrors) {

        this.state = undefined;
        Logger.log(`Reset state for '${this.key}', reason=${reason}`);

        // }
    }

    private async update(options: { forceBlameChange?: boolean, initializing?: boolean } = {}) {
        if (this._disposed || this._uri === undefined) {
            this._hasRemotes = false;
            this._isTracked = false;

            return;
        }

        const isActive = this.isActive();

        const wasBlameable = options.forceBlameChange ? undefined : this.isBlameable;

        this._isTracked = await Container.git.isTracked(this._uri);
        if (isActive) {
            const blameable = this.isBlameable;

            setCommandContext(CommandContext.ActiveIsRevision, this.isRevision);
            setCommandContext(CommandContext.ActiveFileIsTracked, this.isTracked);
            setCommandContext(CommandContext.ActiveIsBlameable, blameable);

            if (!options.initializing && wasBlameable !== blameable) {
                const e = { document: this.document, blameable: blameable } as DocumentBlameStateChangeEvent;
                this._onDidBlameStateChange.fire(e);
                this._eventDelegates.onDidBlameStateChange(e);
            }
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
            setCommandContext(CommandContext.ActiveHasRemote, this.hasRemotes);
        }
    }

    private _hasRemotes: boolean = false;
    get hasRemotes() {
        return this._hasRemotes;
    }

    get isBlameable() {
        return this._blameFailed ? false : this._isTracked;
    }

    get isRevision() {
        return this._uri !== undefined ? !!this._uri.sha : false;
    }

    private _isTracked: boolean = false;
    get isTracked() {
        return this._isTracked;
    }

    private _shouldTriggerOnNextChange: boolean = false;
    get shouldTriggerOnNextChange() {
        return this._shouldTriggerOnNextChange;
    }

    get uri() {
        return this._uri;
    }

    activate() {
        setCommandContext(CommandContext.ActiveIsRevision, this.isRevision);
        setCommandContext(CommandContext.ActiveFileIsTracked, this.isTracked);
        setCommandContext(CommandContext.ActiveIsBlameable, this.isBlameable);
        setCommandContext(CommandContext.ActiveHasRemote, this.hasRemotes);
    }

    getRepository() {
        return this._repo;
    }

    resetTriggerOnNextChange() {
        this._shouldTriggerOnNextChange = false;
    }

    setTriggerOnNextChange() {
        this._shouldTriggerOnNextChange = true;
    }

    private isActive() {
        const editor = window.activeTextEditor;
        return editor !== undefined && editor.document === this.document;
    }
}
