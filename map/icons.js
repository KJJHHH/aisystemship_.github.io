// UIUX/map/icons.js
// Extracted icon creation helpers for SeaDot
(function () {
    function createSeaDotIcon(dotData, sizes = { width: 14, height: 14, iconSize: [24, 24], iconAnchor: [12, 12] }, shadowColor = 'rgba(102, 231, 255, 0.6)', borderStyle = '') {
        const w = sizes.width || 14;
        const h = sizes.height || 14;
        let shapeStyle = '';
        let iconAnchor = sizes.iconAnchor || [w / 2, h];

        const isTrackPoint = dotData && (dotData.type === 'History' || dotData.type === 'Current' || dotData.type === 'Future');

        // prefer canonical helpers to resolve colors when available
        const helpers = (typeof window !== 'undefined' && window.safePointHelpers) ? window.safePointHelpers : null;
        // Prefer dotColor from helpers for track-point triangle fill (dot color represents the point state)
        let resolvedBackground;
        if (helpers) {
            // Try dotColor first (this will return #FFD54A for Future via helper), then backgroundColor
            resolvedBackground = (typeof helpers.getDotColor === 'function' && helpers.getDotColor(dotData)) || (typeof helpers.getBackgroundColor === 'function' && helpers.getBackgroundColor(dotData)) || dotData.backgroundColor || dotData.dotColor || (dotData.type === 'Future' ? '#FFD54A' : '#2196F3');
        } else {
            // legacy fallback: prefer explicit fields, then default to blue (not green)
            resolvedBackground = dotData.backgroundColor || dotData.dotColor || (dotData.type === 'Future' ? '#FFD54A' : '#2196F3');
        }

        if (isTrackPoint) {
            // triangle for track points
            shapeStyle = `
                width: 0;
                height: 0;
                border-left: ${w/2}px solid transparent;
                border-right: ${w/2}px solid transparent;
                border-bottom: ${h}px solid ${resolvedBackground};
                border-radius: 0;
                box-shadow: 0 2px 8px ${shadowColor};
            `;
            borderStyle = '';
            iconAnchor = [ (sizes.iconSize && sizes.iconSize[0]) ? sizes.iconSize[0]/2 : w/2, (sizes.iconSize && sizes.iconSize[1]) ? sizes.iconSize[1] - 2 : h - 2 ];
        } else {
            shapeStyle = `
                background: ${resolvedBackground};
                ${borderStyle}
                border-radius: ${dotData.borderRadius || '50%'};
                width: ${w}px;
                height: ${h}px;
                box-shadow: 0 0 15px ${shadowColor};
            `;
        }

        const html = `<div class="sea-dot-inner" style="${shapeStyle}opacity: 0.9;cursor: pointer;position: relative;z-index: 1000;pointer-events: auto;transform-origin: center center;"></div>`;

        return L.divIcon({
            html: html,
            className: 'custom-event-marker-static',
            iconSize: sizes.iconSize || [w, h],
            iconAnchor: iconAnchor
        });
    }

    // expose to global for non-module environment
    window.icons = window.icons || {};
    window.icons.createSeaDotIcon = createSeaDotIcon;
})();
