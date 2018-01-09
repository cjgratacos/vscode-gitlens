'use strict';
import { ExtensionContext } from 'vscode';
import { DocumentStateTracker, GitDocumentState } from './documentStateTracker';
import { GitService } from './gitService';

export class Container {

    private static _context: ExtensionContext;
    static get context() {
        return Container._context;
    }
    static set context(value: ExtensionContext) {
        Container._context = value;
    }

    private static _git: GitService;
    static get git() {
        return Container._git;
    }
    static set git(value: GitService) {
        Container._git = value;
    }

    private static _tracker: DocumentStateTracker<GitDocumentState>;
    static get tracker() {
        return Container._tracker;
    }
    static set tracker(value: DocumentStateTracker<GitDocumentState>) {
        Container._tracker = value;
    }
}
