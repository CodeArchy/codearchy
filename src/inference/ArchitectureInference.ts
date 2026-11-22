import {
    ArchitectureGraph,
    SubsystemInfo,
    GraphNode,
    GraphEdge,
} from '../model';

const SUBSYSTEM_COLORS = [
    '#4FC3F7', '#81C784', '#FFB74D', '#E57373',
    '#BA68C8', '#4DB6AC', '#FF8A65', '#90A4AE',
    '#AED581', '#FFD54F', '#F06292', '#7986CB',
];

/**
 * Keyword groups, matched against whole path tokens (never substrings):
 * `ui` matches `ui/` or `UiButton.tsx`, but not `build/` or `guide.md`.
 * Order matters only for ties within one token.
 */
const HEURISTIC_GROUPS: Array<[string, string[]]> = [
    ['Tests', ['test', 'tests', 'spec', 'specs', 'mock', 'mocks', 'fixture', 'fixtures', 'e2e', 'testing', 'conftest']],
    ['API / Routes', ['route', 'routes', 'router', 'routers', 'controller', 'controllers', 'handler', 'handlers', 'endpoint', 'endpoints', 'api', 'apis', 'middleware', 'middlewares', 'graphql', 'resolver', 'resolvers', 'rest', 'rpc', 'grpc']],
    ['Auth / Security', ['auth', 'authentication', 'authorization', 'login', 'logout', 'session', 'sessions', 'token', 'tokens', 'permission', 'permissions', 'role', 'roles', 'guard', 'guards', 'security', 'password', 'oauth', 'jwt', 'acl']],
    ['Models / Data', ['model', 'models', 'schema', 'schemas', 'entity', 'entities', 'dto', 'dtos', 'migration', 'migrations', 'database', 'db', 'repository', 'repositories', 'repo', 'repos', 'dao', 'orm', 'prisma', 'sql', 'store', 'stores']],
    ['Services / Logic', ['service', 'services', 'provider', 'providers', 'manager', 'managers', 'engine', 'processor', 'processors', 'worker', 'workers', 'job', 'jobs', 'task', 'tasks', 'usecase', 'usecases', 'domain', 'core', 'logic']],
    ['Views / UI', ['view', 'views', 'component', 'components', 'page', 'pages', 'layout', 'layouts', 'template', 'templates', 'screen', 'screens', 'widget', 'widgets', 'ui', 'webview', 'frontend', 'hooks', 'styles']],
    ['Messaging / Events', ['event', 'events', 'listener', 'listeners', 'emitter', 'queue', 'queues', 'pubsub', 'message', 'messages', 'messaging', 'notification', 'notifications', 'webhook', 'webhooks', 'kafka', 'broker', 'consumer', 'consumers', 'producer']],
    ['Storage / Files', ['storage', 'upload', 'uploads', 'file', 'files', 'asset', 'assets', 'media', 'image', 'images', 'blob', 'blobs', 's3', 'cache']],
    ['Types / Interfaces', ['type', 'types', 'typings', 'interface', 'interfaces', 'contract', 'contracts', 'definition', 'definitions', 'protocol', 'proto']],
    ['Utilities', ['util', 'utils', 'utility', 'utilities', 'helper', 'helpers', 'common', 'shared', 'lib', 'libs', 'tool', 'tools', 'constant', 'constants', 'config', 'configs', 'configuration', 'env', 'misc']],
];

const KEYWORD_TO_GROUP = new Map<string, string>();
for (const [group, keywords] of HEURISTIC_GROUPS) {
    for (const k of keywords) if (!KEYWORD_TO_GROUP.has(k)) KEYWORD_TO_GROUP.set(k, group);
}

/** Lower-case word tokens of one path segment: `UserController.test.ts` → user, controller, test. */
export function tokenizeSegment(segment: string): string[] {
    return segment
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((t) => t.toLowerCase())
        .filter(Boolean);
}

/**
 * Heuristic group for a workspace-relative path. Test markers anywhere win
 * (a test tree contains every other keyword); otherwise the most specific
 * token wins: the file name first, then its nearest directory, and so on.
 */
export function heuristicGroupForPath(relativePath: string): string | undefined {
    const segments = relativePath.split('/').filter(Boolean);
    if (segments.length === 0) return undefined;
    const fileName = segments[segments.length - 1].replace(/\.[^.]+$/, '');
    const tokenLists = [...segments.slice(0, -1), fileName].map(tokenizeSegment);

    if (tokenLists.some((tokens) => tokens.some((t) => KEYWORD_TO_GROUP.get(t) === 'Tests'))) return 'Tests';
    for (let i = tokenLists.length - 1; i >= 0; i--) {
        for (const token of tokenLists[i]) {
            const group = KEYWORD_TO_GROUP.get(token);
            if (group) return group;
        }
    }
    return undefined;
}

export class ArchitectureInference {
    inferSubsystems(graph: ArchitectureGraph): ArchitectureGraph {
        const subsystems: SubsystemInfo[] = [];
        const assignments = new Map<string, string>();

        // Phase 1: Directory-based grouping
        const dirGroups = this.groupByDirectory(graph.nodes);

        // Phase 2: Heuristic semantic grouping
        for (const node of graph.nodes) {
            const heuristicGroup = this.matchHeuristicGroup(node);
            if (heuristicGroup) {
                assignments.set(node.id, heuristicGroup);
            }
        }

        // Phase 3: Merge directory grouping with heuristic grouping
        for (const [dir, nodeIds] of dirGroups) {
            const heuristicCounts = new Map<string, number>();
            for (const nodeId of nodeIds) {
                const group = assignments.get(nodeId);
                if (group) {
                    heuristicCounts.set(group, (heuristicCounts.get(group) || 0) + 1);
                }
            }

            let groupName: string;
            if (heuristicCounts.size > 0) {
                // Use the most common heuristic group in this directory
                groupName = [...heuristicCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
            } else {
                groupName = this.humanizeDirectoryName(dir);
            }

            for (const nodeId of nodeIds) {
                if (!assignments.has(nodeId)) {
                    assignments.set(nodeId, groupName);
                }
            }
        }

        // Phase 4: Connectivity-based refinement
        this.refineByConnectivity(graph, assignments);

        // Build subsystem objects
        const groupedNodes = new Map<string, string[]>();
        for (const [nodeId, group] of assignments) {
            const existing = groupedNodes.get(group) || [];
            existing.push(nodeId);
            groupedNodes.set(group, existing);
        }

        const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
        let colorIndex = 0;
        for (const [name, nodeIds] of groupedNodes) {
            if (nodeIds.length === 0) continue;

            subsystems.push({
                id: `subsystem-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                name,
                description: `Contains ${nodeIds.length} module(s): ${this.describeSubsystem(nodeIds, labels)}`,
                nodeIds,
                color: SUBSYSTEM_COLORS[colorIndex % SUBSYSTEM_COLORS.length],
            });
            colorIndex++;
        }

        // Assign group info to nodes
        const updatedNodes = graph.nodes.map((node) => ({
            ...node,
            group: assignments.get(node.id),
        }));

        return {
            ...graph,
            nodes: updatedNodes,
            subsystems,
        };
    }

    private groupByDirectory(nodes: GraphNode[]): Map<string, string[]> {
        const groups = new Map<string, string[]>();
        for (const node of nodes) {
            const parts = node.id.split('/');
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
            const existing = groups.get(dir) || [];
            existing.push(node.id);
            groups.set(dir, existing);
        }
        return groups;
    }

    private matchHeuristicGroup(node: GraphNode): string | undefined {
        return heuristicGroupForPath(node.id);
    }

    private refineByConnectivity(graph: ArchitectureGraph, assignments: Map<string, string>) {
        const unassigned = graph.nodes.filter((n) => !assignments.has(n.id));
        if (unassigned.length === 0) return;

        const adjacency = this.buildAdjacency(graph.edges);

        for (const node of unassigned) {
            const neighbors = adjacency.get(node.id) || [];
            const neighborGroups = new Map<string, number>();

            for (const neighborId of neighbors) {
                const group = assignments.get(neighborId);
                if (group) {
                    neighborGroups.set(group, (neighborGroups.get(group) || 0) + 1);
                }
            }

            if (neighborGroups.size > 0) {
                const bestGroup = [...neighborGroups.entries()].sort((a, b) => b[1] - a[1])[0][0];
                assignments.set(node.id, bestGroup);
            } else {
                assignments.set(node.id, 'Other');
            }
        }
    }

    private buildAdjacency(edges: GraphEdge[]): Map<string, string[]> {
        const adj = new Map<string, string[]>();
        for (const edge of edges) {
            const sourceNeighbors = adj.get(edge.source) || [];
            sourceNeighbors.push(edge.target);
            adj.set(edge.source, sourceNeighbors);

            const targetNeighbors = adj.get(edge.target) || [];
            targetNeighbors.push(edge.source);
            adj.set(edge.target, targetNeighbors);
        }
        return adj;
    }

    private humanizeDirectoryName(dir: string): string {
        const parts = dir.split('/');
        const last = parts[parts.length - 1] || dir;
        return last.charAt(0).toUpperCase() + last.slice(1).replace(/[-_]/g, ' ');
    }

    private describeSubsystem(nodeIds: string[], labels: Map<string, string>): string {
        const maxShow = 3;
        const nodes = nodeIds.slice(0, maxShow).map((id) => labels.get(id) || id);
        const suffix = nodeIds.length > maxShow ? ` and ${nodeIds.length - maxShow} more` : '';
        return nodes.join(', ') + suffix;
    }
}
