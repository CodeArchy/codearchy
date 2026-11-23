/**
 * @codearchy/ui — CodeArchy's shared UI. Hosts render <CodeArchyMap> with an
 * EngineClient (their transport to the engine) and import
 * `@codearchy/ui/styles.css`.
 */
export { CodeArchyMap, type CodeArchyMapProps } from './CodeArchyMap.js';
export type { EngineClient, HostActions, SearchResult } from './client.js';
export { buildMapModel, neighbourhood, strokeWidthFor, visibleEdges, DEFAULT_EDGE_LIMIT, lensBadge, matrixOrder, heatStep, LENSES, type LensId, type LensBadge, type MatrixOrder, externalId, keyOfExternal, type MapModel, type MapNode, type MapEdge } from './model.js';
export { LayoutEngine, toElkGraph, fromElkGraph, type Layout, type Box } from './layout.js';
