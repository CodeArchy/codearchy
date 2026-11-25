/**
 * CodeArchy's settings for the Map's Settings panel: every `codearchy.*`
 * setting the extension contributes (read from its own package.json, so new
 * settings show up without UI work), with its values at each scope, and
 * updates from the panel, checked against the schema before they're written.
 */
import * as vscode from 'vscode';
import { invalid, type SettingSchema, type SettingsSnapshot } from './settingsModel';

export { settingsSchema, invalid, type SettingSchema, type SettingValue, type SettingsSnapshot, type SettingsTarget } from './settingsModel';

export function settingsSnapshot(schema: SettingSchema[]): SettingsSnapshot {
    const config = vscode.workspace.getConfiguration();
    return {
        hasWorkspace: !!vscode.workspace.workspaceFolders?.length,
        settings: schema.map((s) => {
            const i = config.inspect(s.key);
            return {
                ...s,
                ...(i?.globalValue !== undefined ? { user: i.globalValue } : {}),
                ...(i?.workspaceValue !== undefined ? { workspace: i.workspaceValue } : {}),
                value: config.get(s.key),
            };
        }),
    };
}

/**
 * Writes a setting from the panel. Only known keys, values that fit the
 * schema, and scopes the setting allows; `undefined` resets it at that scope.
 */
export async function updateSetting(schema: SettingSchema[], key: unknown, value: unknown, target: unknown): Promise<void> {
    const s = schema.find((x) => x.key === key);
    if (!s) throw new Error(`Not a CodeArchy setting: ${String(key)}`);
    if (target !== 'user' && target !== 'workspace') throw new Error('The target is user or workspace');
    if (target === 'workspace' && (s.scope === 'application' || s.scope === 'machine')) throw new Error(`${s.key} applies to the whole machine, not one workspace`);
    if (target === 'workspace' && !vscode.workspace.workspaceFolders?.length) throw new Error('Open a folder to change workspace settings');
    if (value !== undefined) {
        const problem = invalid(s, value);
        if (problem) throw new Error(`${s.key}: ${problem}`);
    }
    await vscode.workspace.getConfiguration().update(s.key, value, target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
}
