'use strict';
import { Functions, IDeferred } from '../system';
import { ConfigurationChangeEvent, Disposable, Event, EventEmitter, TextDocumentChangeEvent, TextEditor, TextEditorSelectionChangeEvent, window, workspace } from 'vscode';
import { TextDocumentComparer } from '../comparers';
import { configuration } from '../configuration';
import { CommandContext, isTextEditor, setCommandContext } from '../constants';
import { GitChangeEvent, GitChangeReason, GitService, GitUri, Repository, RepositoryChangeEvent } from '../gitService';
import { Logger } from '../logger';

export enum BlameabilityChangeReason {
    BlameFailed = 'blame-failed',
    DocumentChanged = 'document-changed',
    EditorChanged = 'editor-changed',
    RepoChanged = 'repo-changed'
}

export interface BlameabilityChangeEvent {
    editor: TextEditor | undefined;

    blameable: boolean;
    dirty: boolean;
    reason: BlameabilityChangeReason;
}

export interface LineDirtyStateChangeEvent {
    editor: TextEditor | undefined;

    dirty: boolean;
    line: number;
    lineDirty: boolean;
}

interface Context {
    editor?: TextEditor;
    repo?: Repository;
    repoDisposable?: Disposable;
    state: ContextState;
    uri?: GitUri;
}

interface ContextState {
    blameable?: boolean;
    dirty: boolean;
    line?: number;
    lineDirty?: boolean;
    revision?: boolean;
    tracked?: boolean;
}

export class GitContextTracker extends Disposable {

    private _onDidChangeBlameability = new EventEmitter<BlameabilityChangeEvent>();
    get onDidChangeBlameability(): Event<BlameabilityChangeEvent> {
        return this._onDidChangeBlameability.event;
    }

    private _onDidChangeLineDirtyState = new EventEmitter<LineDirtyStateChangeEvent>();
    get onDidChangeLineDirtyState(): Event<LineDirtyStateChangeEvent> {
        return this._onDidChangeLineDirtyState.event;
    }

    private readonly _context: Context = { state: { dirty: false } };
    private readonly _disposable: Disposable;
    private _listenersDisposable: Disposable | undefined;
    private _onLineDirtyStateChangedDebounced: (() => void) & IDeferred;

    constructor(
        private readonly git: GitService
    ) {
        super(() => this.dispose());

        this._onLineDirtyStateChangedDebounced = Functions.debounce(this.onLineDirtyStateChanged, 1000);

        this._disposable = Disposable.from(
            workspace.onDidChangeConfiguration(this.onConfigurationChanged, this)
        );
        this.onConfigurationChanged(configuration.initializingChangeEvent);
    }

    dispose() {
        this._listenersDisposable && this._listenersDisposable.dispose();
        this._disposable && this._disposable.dispose();
    }

    private onConfigurationChanged(e: ConfigurationChangeEvent) {
        if (!configuration.initializing(e) && !e.affectsConfiguration('git.enabled', null!)) return;

        const enabled = workspace.getConfiguration('git', null!).get<boolean>('enabled', true);
        if (this._listenersDisposable !== undefined) {
            this._listenersDisposable.dispose();
            this._listenersDisposable = undefined;
        }

        setCommandContext(CommandContext.Enabled, enabled);

        if (enabled) {
            this._listenersDisposable = Disposable.from(
                window.onDidChangeActiveTextEditor(Functions.debounce(this.onActiveTextEditorChanged, 50), this),
                workspace.onDidChangeTextDocument(this.onTextDocumentChanged, this),
                window.onDidChangeTextEditorSelection(this.onTextEditorSelectionChanged, this),
                this.git.onDidBlameFail(this.onBlameFailed, this),
                this.git.onDidChange(this.onGitChanged, this)
            );

            this.updateContext(BlameabilityChangeReason.EditorChanged, window.activeTextEditor, true);
        }
        else {
            this.updateContext(BlameabilityChangeReason.EditorChanged, window.activeTextEditor, false);
        }
    }

    private onActiveTextEditorChanged(editor: TextEditor | undefined) {
        if (editor === this._context.editor) return;
        if (editor !== undefined && !isTextEditor(editor)) return;

        // Logger.log('GitContextTracker.onActiveTextEditorChanged', editor && editor.document.uri.fsPath);

        this.updateContext(BlameabilityChangeReason.EditorChanged, editor, true);
    }

    private onBlameFailed(key: string) {
        if (this._context.editor === undefined || key !== this.git.getCacheEntryKey(this._context.editor.document.uri)) return;

        this.updateBlameability(BlameabilityChangeReason.BlameFailed, false);
    }

    private onLineDirtyStateChanged() {
        this._onDidChangeLineDirtyState.fire({
            editor: this._context.editor,
            dirty: this._context.state.dirty,
            line: this._context.state.line,
            lineDirty: this._context.state.lineDirty
        } as LineDirtyStateChangeEvent);
    }

    private onGitChanged(e: GitChangeEvent) {
        if (e.reason !== GitChangeReason.Repositories) return;

        this.updateRemotes();
    }

    private onRepoChanged(e: RepositoryChangeEvent) {
        this.updateContext(BlameabilityChangeReason.RepoChanged, this._context.editor);
        this.updateRemotes();
    }

    private onTextDocumentChanged(e: TextDocumentChangeEvent) {
        if (this._context.editor === undefined || !TextDocumentComparer.equals(this._context.editor.document, e.document)) return;

        const dirty = e.document.isDirty;

        const line = (this._context.editor && this._context.editor.selection.active.line) || -1;

        if (dirty === this._context.state.dirty && this._context.state.line === line && this._context.state.lineDirty === dirty) {
            // TODO: Only fire this when we are annotating
            this._onLineDirtyStateChangedDebounced();

            return;
        }

        // Logger.log('GitContextTracker.onTextDocumentChanged', `Dirty(${dirty}) state changed`);

        this._context.state.dirty = dirty;
        this._context.state.line = line;
        this._context.state.lineDirty = dirty;

        if (dirty) {
            this._onLineDirtyStateChangedDebounced.cancel();
            setImmediate(() => this.onLineDirtyStateChanged());

            return;
        }

        this._onLineDirtyStateChangedDebounced();
    }

    private onTextEditorSelectionChanged(e: TextEditorSelectionChangeEvent) {
        if (this._context.state.line === e.selections[0].active.line) return;

        this._context.state.line = undefined;
        this._context.state.lineDirty = false;
    }

    private async updateContext(reason: BlameabilityChangeReason, editor: TextEditor | undefined, force: boolean = false) {
        try {
            let dirty = false;
            let revision = false;
            let tracked = false;
            if (force || this._context.editor !== editor) {
                this._context.editor = editor;
                this._context.repo = undefined;
                if (this._context.repoDisposable !== undefined) {
                    this._context.repoDisposable.dispose();
                    this._context.repoDisposable = undefined;
                }

                if (editor !== undefined) {
                    this._context.uri = await GitUri.fromUri(editor.document.uri, this.git);

                    const repo = await this.git.getRepository(this._context.uri);
                    if (repo !== undefined) {
                        this._context.repo = repo;
                        this._context.repoDisposable = repo.onDidChange(this.onRepoChanged, this);
                    }

                    dirty = editor.document.isDirty;
                    revision = !!this._context.uri.sha;
                    tracked = await this.git.isTracked(this._context.uri);
                }
                else {
                    this._context.uri = undefined;
                    this._context.state.blameable = false;
                }
            }
            // Since the revision or tracked state could have changed, update it
            else if (this._context.uri !== undefined) {
                revision = !!this._context.uri.sha;
                tracked = await this.git.isTracked(this._context.uri);
            }

            if (this._context.state.revision !== revision) {
                this._context.state.revision = revision;
                setCommandContext(CommandContext.ActiveIsRevision, revision);
            }

            if (this._context.state.tracked !== tracked) {
                this._context.state.tracked = tracked;
                setCommandContext(CommandContext.ActiveFileIsTracked, tracked);
            }

            if (this._context.state.dirty !== dirty) {
                this._context.state.dirty = dirty;
                this._onLineDirtyStateChangedDebounced();
            }

            this.updateBlameability(reason, undefined, force);
            this.updateRemotes();
        }
        catch (ex) {
            Logger.error(ex, 'GitContextTracker.updateContext');
        }
    }

    private updateBlameability(reason: BlameabilityChangeReason, blameable?: boolean, force: boolean = false) {
        try {
            if (blameable === undefined) {
                blameable = this._context.state.tracked; // && !this._context.state.dirty;
            }

            if (!force && this._context.state.blameable === blameable) return;

            this._context.state.blameable = blameable;

            setCommandContext(CommandContext.ActiveIsBlameable, blameable);
            this._onDidChangeBlameability.fire({
                editor: this._context.editor,
                blameable: blameable!,
                dirty: this._context.state.dirty,
                reason: reason
            } as BlameabilityChangeEvent);
        }
        catch (ex) {
            Logger.error(ex, 'GitContextTracker.updateBlameability');
        }
    }

    private async updateRemotes() {
        try {
            let hasRemotes = false;
            if (this._context.repo !== undefined) {
                hasRemotes = await this._context.repo.hasRemote();
            }

            setCommandContext(CommandContext.ActiveHasRemote, hasRemotes);

            if (!hasRemotes) {
                const repositories = await this.git.getRepositories();
                for (const repo of repositories) {
                    if (repo === this._context.repo) continue;

                    hasRemotes = await repo.hasRemotes();
                    if (hasRemotes) break;
                }
            }

            setCommandContext(CommandContext.HasRemotes, hasRemotes);
        }
        catch (ex) {
            Logger.error(ex, 'GitContextTracker.updateRemotes');
        }
    }
}