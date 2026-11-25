import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { invalid, settingsSchema } from '../../webview/settingsModel';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

suite('settings panel: the codearchy.* settings from the manifest', () => {
    test('every contributed setting is read, with its type, default, description and choices', () => {
        const schema = settingsSchema(manifest);
        const contributed = Object.keys((Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration]).reduce((all: object, s: { properties: object }) => ({ ...all, ...s.properties }), {}));
        assert.deepStrictEqual(schema.map((s) => s.key).sort(), contributed.filter((k) => k.startsWith('codearchy.')).sort());
        assert.ok(schema.every((s) => s.description.length > 0), 'every setting explains itself');
        const people = schema.find((s) => s.key === 'codearchy.authorship.people')!;
        assert.deepStrictEqual([people.type, people.default], ['boolean', true]);
        assert.ok(schema.find((s) => s.key === 'codearchy.ui')!.enum!.length >= 2);
        assert.ok(schema.find((s) => s.key === 'codearchy.authorship.agentLogs')!.items!.enum!.includes('claude-code'));
    });

    test('values from the panel are checked against the schema before anything is written', () => {
        const schema = settingsSchema(manifest);
        const get = (k: string) => schema.find((s) => s.key === `codearchy.${k}`)!;
        assert.strictEqual(invalid(get('authorship.people'), false), undefined);
        assert.match(invalid(get('authorship.people'), 'yes')!, /true or false/);
        assert.strictEqual(invalid(get('ui'), get('ui').enum![0]), undefined);
        assert.match(invalid(get('ui'), 'something-else')!, /one of/);
        assert.strictEqual(invalid(get('maxFiles'), 5000), undefined);
        assert.match(invalid(get('maxFiles'), Number.NaN)!, /number/);
        assert.strictEqual(invalid(get('authorship.agentLogs'), ['claude-code']), undefined);
        assert.match(invalid(get('authorship.agentLogs'), ['rm -rf'])!, /isn't one of/);
        assert.strictEqual(invalid(get('excludePatterns'), ['**/generated/**']), undefined);
        assert.match(invalid(get('excludePatterns'), [42])!, /list of text/);
        assert.match(invalid({ key: 'x', type: 'object', description: '' }, {})!, /settings\.json/);
    });
});
