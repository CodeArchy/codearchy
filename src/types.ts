import * as vscode from 'vscode';
import { DEFAULT_LANGUAGE_IDS } from './analysis/languages';
import { DEFAULT_EXCLUDE_PATTERNS } from './analysis/discovery';

export * from './model';
export { LANGUAGE_EXTENSIONS, getLanguageFromExtension } from './analysis/languages';

export interface ExtensionConfig {
    includedLanguages: string[];
    excludePatterns: string[];
    maxFileSize: number;
    /** 0 = unlimited. When the limit is hit, the user is told — never silent. */
    maxFiles: number;
    aiModel: 'gemma-e2b' | 'gemma-e4b' | 'none';
    aiProcessing: 'fast' | 'moderate' | 'indepth';
}

export function getConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('codearchy');
    return {
        includedLanguages: config.get<string[]>('includedLanguages', DEFAULT_LANGUAGE_IDS),
        excludePatterns: config.get<string[]>('excludePatterns', DEFAULT_EXCLUDE_PATTERNS),
        maxFileSize: config.get<number>('maxFileSize', 500000),
        maxFiles: config.get<number>('maxFiles', 20000),
        aiModel: config.get<'gemma-e2b' | 'gemma-e4b' | 'none'>('aiModel', 'none'),
        aiProcessing: config.get<'fast' | 'moderate' | 'indepth'>('aiProcessing', 'moderate'),
    };
}
