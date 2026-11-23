import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MapShell } from './MapShell';

declare global {
    interface Window {
        /** Set by the extension host from the `codearchy.ui` setting. */
        CODEARCHY_UI?: 'map' | 'classic';
    }
}

// Both UIs are bundled statically: CSS imported from lazily loaded chunks would
// land in chunk stylesheets the webview never links.
const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(window.CODEARCHY_UI === 'classic' ? <App /> : <MapShell />);
}
