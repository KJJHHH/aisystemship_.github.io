// UIUX/map/SeaDotManager.js
// Lightweight wrapper to ensure a global `window.seaDotManager` is available.
// This file is a safe bridge for incremental refactoring: it does not
// move or duplicate logic from the monolithic `UIUX/script.js` but exposes
// the SeaDotManager class instance when it's defined there.
// This file intentionally does NOT auto-instantiate a SeaDotManager.
// It only exposes a helper that other modules can call to attach a single
// instance when appropriate. This avoids double-instantiation due to
// script load order during the incremental refactor.
// UIUX/map/SeaDotManager.js
// Standalone implementation of the SeaDotManager class extracted from the monolithic
// `UIUX/script.js`. This file registers `window.SeaDotManager` (the class) and
// exposes `window.__attachSeaDotManager()` helper which will instantiate a single
// `window.seaDotManager` when called by application bootstrap code.

(function(){
    class SeaDotManager {
        constructor() {
            this.seaDots = new Map(); // 儲存所有海域監測點
            this.dotIdCounter = 1;
        }

        createSeaDotIcon(dotData, sizes, shadowColor, borderStyle) {
            let shapeStyle = '';
                // prefer canonical helpers when available to resolve display colors
                const helpers = (typeof window !== 'undefined' && window.safePointHelpers) ? window.safePointHelpers : null;
                // prefer helpers which already resolve display.*; fall back to display.* then legacy fields
                const _getDotColor = helpers && typeof helpers.getDotColor === 'function' ? helpers.getDotColor : (p => ((p && p.display && p.display.dotColor) ? p.display.dotColor : (p && p.dotColor) || null));
                const _getBackgroundColor = helpers && typeof helpers.getBackgroundColor === 'function' ? helpers.getBackgroundColor : (p => ((p && p.display && p.display.backgroundColor) ? p.display.backgroundColor : (p && p.backgroundColor) || (p && p.bgColor) || null));
                // Prefer dotColor first, then backgroundColor. If point.type === 'Future' force yellow.
                let resolvedBackground;
                if (typeof _getDotColor === 'function') resolvedBackground = _getDotColor(dotData) || null;
                if (!resolvedBackground && typeof _getBackgroundColor === 'function') resolvedBackground = _getBackgroundColor(dotData) || null;
                if (!resolvedBackground) {
                    // Future points should be warm yellow
                    resolvedBackground = (dotData && dotData.type === 'Future') ? '#FFD54A' : '#2196F3';
                }
                const resolvedDotColor = resolvedBackground;
            let iconAnchor = sizes.iconAnchor;
            const isTrackPoint = dotData.type === 'History' || dotData.type === 'Current' || dotData.type === 'Future';

            if (isTrackPoint) {
                shapeStyle = `
                    width: 0;
                    height: 0;
                    border-left: ${sizes.width/2}px solid transparent;
                    border-right: ${sizes.width/2}px solid transparent;
                        border-bottom: ${sizes.height}px solid ${resolvedBackground};
                    border-radius: 0;
                    box-shadow: 0 2px 8px ${shadowColor};
                `;
                borderStyle = '';
                iconAnchor = [sizes.iconSize[0]/2, sizes.iconSize[1] - 2];
            } else {
                shapeStyle = `
                        background: ${resolvedBackground}; 
                    ${borderStyle}
                    border-radius: ${dotData.borderRadius}; 
                    width: ${sizes.width}px; 
                    height: ${sizes.height}px; 
                    box-shadow: 0 0 15px ${shadowColor};
                `;
            }

            return L.divIcon({
                html: `<div class="sea-dot-inner" style="
                    ${shapeStyle}
                    opacity: 0.9;
                    cursor: pointer;
                    position: relative;
                    z-index: 1000;
                    pointer-events: auto;
                    transform-origin: center center;
                "></div>`,
                className: 'custom-event-marker-static',
                iconSize: sizes.iconSize,
                iconAnchor: iconAnchor
            });
        }

        // New wrapper: accept a canonical point object and adapt to legacy dotData shape
        createSeaDotFromPoint(point) {
            if (!point) return null;
            const helpers = (typeof window !== 'undefined' && window.safePointHelpers) ? window.safePointHelpers : null;
            const getSafePointId = helpers ? helpers.getSafePointId : (p => (p && (p.pointId || p.id)) || null);
            const display = point.display || {};
            const lat = point.lat;
            const lon = point.lon;
            const id = getSafePointId(point);
            const status = display.status || point.status || 'unknown';
            // preserve legacy API: call createSeaDot with values
            return this.createSeaDot(lat, lon, id, status);
        }

        createTrackSeaDot(lat, lon, id, status, type, trackPointData, vesselId) {
            // trackPointData may already be canonical; prefer display.* over top-level properties
            const display = (trackPointData && trackPointData.display) ? trackPointData.display : null;
            let backgroundColor, dotColor, borderRadius;
            const isAbnormalSignal = this.checkSignalAbnormality(trackPointData || {});

            // Force any Future-type point to be warm yellow and never allow
            // abnormality logic to overwrite it. This guarantees consistent
            // presentation for planned/future points used in demos.
            if (type === 'Future') {
                backgroundColor = '#FFD54A';
                dotColor = '#FFD54A';
            } else if (display && (display.backgroundColor || display.dotColor)) {
                // prefer display subobject when present
                backgroundColor = display.backgroundColor || display.dotColor || '#2196F3';
                dotColor = display.dotColor || display.backgroundColor || '#2196F3';
            } else if (trackPointData && (trackPointData.backgroundColor || trackPointData.dotColor)) {
                // fallback to legacy top-level props on trackPointData
                backgroundColor = trackPointData.backgroundColor || trackPointData.dotColor || '#2196F3';
                dotColor = trackPointData.dotColor || trackPointData.backgroundColor || '#2196F3';
            } else {
                if (isAbnormalSignal) {
                    backgroundColor = '#ef4444';
                    dotColor = '#ef4444';
                } else {
                    // default to blue for track points (not the green used for some non-track markers)
                    backgroundColor = '#2196F3';
                    dotColor = '#2196F3';
                }
            }

            if (display && display.borderRadius) {
                borderRadius = display.borderRadius;
            } else if (trackPointData && trackPointData.borderRadius) {
                borderRadius = trackPointData.borderRadius;
            } else if (type === 'History') {
                borderRadius = '2px';
            } else {
                borderRadius = '50%';
            }

            const dotData = {
                id: id,
                lat: lat,
                lon: lon,
                status: status,
                type: type,
                backgroundColor: backgroundColor,
                dotColor: dotColor,
                borderRadius: borderRadius,
                trackPointData: trackPointData,
                vesselId: vesselId,
                // expose display consistently for downstream code
                display: display || (trackPointData && trackPointData.display) || { backgroundColor, dotColor, borderRadius, status }
            };

            const marker = this.createTrackMarker(dotData);
            return marker;
        }

        // New wrapper: accept canonical point object and adapt
        createTrackSeaDotFromPoint(point) {
            if (!point) return null;
            const helpers = (typeof window !== 'undefined' && window.safePointHelpers) ? window.safePointHelpers : null;
            const getSafePointId = helpers ? helpers.getSafePointId : (p => (p && (p.pointId || p.id)) || null);
            // prefer display sub-object for UI/display values
            const disp = point.display || {};
            const lat = point.lat;
            const lon = point.lon;
            const id = getSafePointId(point);
            const status = disp.status || point.status || 'unknown';
            const type = point.type || 'Normal';
            // Provide trackPointData for legacy consumers
            const trackPointData = point.trackPointData || Object.assign({}, point);
            const vesselId = point.vesselId || null;
            return this.createTrackSeaDot(lat, lon, id, status, type, trackPointData, vesselId);
        }

        createSeaDot(lat, lon, id, status) {
            let backgroundColor, dotColor, borderRadius;

            switch (status) {
                case 'No AIS':
                    backgroundColor = '#ef4444';
                    dotColor = '#ef4444';
                    break;
                case 'AIS':
                    backgroundColor = '#059669';
                    dotColor = '#059669';
                    break;
                default:
                    backgroundColor = '#059669';
                    dotColor = '#059669';
                    break;
            }

            // Always use Normal style
            borderRadius = '50%';

            const dotData = {
                id: id,
                lat: lat,
                lon: lon,
                status: status,
                type: 'Normal',
                backgroundColor: backgroundColor,
                dotColor: dotColor,
                borderRadius: borderRadius,
                area: this.getAreaName(lat, lon),
                createTime: new Date().toISOString(),
                rfId: generateSingleRFId(),
                marker: null
            };

            const marker = this.createMarker(dotData);
            dotData.marker = marker;
            this.seaDots.set(id, dotData);
            console.log(`🔵 海域監測點 ${id} 已生成 RF 信號 ID: ${dotData.rfId}, 狀態: ${dotData.status}, 類型: ${dotData.type}`);
            return marker;
        }

        checkSignalAbnormality(trackPointData) {
            if (trackPointData.speed && (trackPointData.speed > 25 || trackPointData.speed < 0.5)) {
                return true;
            }
            if (trackPointData.deviationFromRoute && trackPointData.deviationFromRoute > 5) {
                return true;
            }
            if (trackPointData.signalStrength && trackPointData.signalStrength < -80) {
                return true;
            }
            if (trackPointData.inRestrictedZone) {
                return true;
            }
            if (trackPointData.type === 'Future') {
                return Math.random() < 0.3;
            }
            if (trackPointData.hasTask && Math.random() > 0.85) {
                return true;
            }
            return false;
        }

        createTrackMarker(dotData) {
            let borderStyle = '';
                // resolve dotColor via helpers when available (preserve legacy fallback)
                const helpers = (typeof window !== 'undefined' && window.safePointHelpers) ? window.safePointHelpers : null;
                const resolvedDotColor = (helpers && typeof helpers.getDotColor === 'function') ? (helpers.getDotColor(dotData) || dotData.dotColor) : dotData.dotColor;
                let shadowColor = this.hexToRgba(resolvedDotColor, 0.6);
                borderStyle = `border: 2px solid ${resolvedDotColor};`;
            const sizes = { width: 14, height: 14, iconSize: [24, 24], iconAnchor: [12, 12] };
            const trackIcon = this.createSeaDotIcon(dotData, sizes, shadowColor, borderStyle);
            const marker = L.marker([dotData.lat, dotData.lon], { icon: trackIcon });
            // Create popup content for track point
            const pointTime = new Date(dotData.trackPointData.timestamp);
            const isPast = pointTime < new Date();
            const taskStatus = isPast ? '已完成' : '已排程';

            // Use popup instead of modal
            if (window.popups && window.popups.createTrackPointPopupContent) {
                const popupContent = window.popups.createTrackPointPopupContent(
                    dotData.trackPointData,
                    taskStatus,
                    dotData.vesselId
                );
                marker.bindPopup(popupContent, {
                    maxWidth: 350,
                    className: 'track-point-popup'
                });
            } else {
                // Fallback to original modal if popup function not available
                marker.on('click', () => {
                    if (typeof showTrackPointDetails === 'function') {
                        showTrackPointDetails(dotData.trackPointData, taskStatus, dotData.vesselId);
                    }
                });
            }
            return marker;
        }

        createMarker(dotData, map = taiwanMap) {
            console.log("createMarker is executed, dotData:", dotData);
            let borderStyle = '';
            let shadowColor = 'rgba(102, 231, 255, 0.6)';
            const sizes = calculateSeaDotSize(map, { baseSize: 18, baseZoom: 7, scaleFactor: 1.15, minSize: 12, maxSize: 24 });
            // prefer helper resolution for 'none' checks and color derivation
            const resolveDotColor = (typeof window !== 'undefined' && window.safePointHelpers && typeof window.safePointHelpers.getDotColor === 'function') ? window.safePointHelpers.getDotColor : (p => (p && p.dotColor) || null);
            const effectiveColor = (dotData.display && dotData.display.dotColor) ? dotData.display.dotColor : (resolveDotColor(dotData) || dotData.dotColor);
            if (effectiveColor === 'none') {
                borderStyle = 'border: none;';
                shadowColor = 'rgba(102, 231, 255, 0.6)';
            } else {
                shadowColor = this.hexToRgba(effectiveColor, 0.6);
                borderStyle = `border: 2px solid ${effectiveColor};`;
            }
            // ensure dotData has backgroundColor/dotColor consistent with display (use helpers if available)
            const helpers = (typeof window !== 'undefined' && window.safePointHelpers) ? window.safePointHelpers : null;
            const getDotColor = helpers ? helpers.getDotColor : (p => (p && p.dotColor) || null);
            const getBackgroundColor = helpers ? helpers.getBackgroundColor : (p => (p && p.backgroundColor) || null);
            dotData.backgroundColor = (dotData.display && dotData.display.backgroundColor) || getBackgroundColor(dotData) || dotData.backgroundColor;
            dotData.dotColor = (dotData.display && dotData.display.dotColor) || getDotColor(dotData) || dotData.dotColor;
            const dotIcon = this.createSeaDotIcon(dotData, sizes, shadowColor, borderStyle);
            const marker = L.marker([dotData.lat, dotData.lon], { icon: dotIcon, interactive: true, riseOnHover: true, riseOffset: 250 });

            if (window.popups && window.popups.createPopupContent) {
                try {
                    const content = window.popups.createPopupContent(dotData);
                    marker.bindPopup(content, { offset: [0, -10], closeButton: true, autoClose: false, closeOnEscapeKey: true, maxWidth: 280 });
                } catch (err) {
                    console.error('Failed to generate popup content from window.popups:', err);
                }
            } else {
                console.warn('window.popups is not available - popups will not be bound for this marker.');
            }

            marker.on('click', function(e) {
                console.log('SeaDot clicked:', dotData.rfId);
                L.DomEvent.stopPropagation(e);
                L.DomEvent.stop(e);
                if (window.popups && window.popups.updatePopupContent) {
                    try { window.popups.updatePopupContent(marker, dotData); } catch (err) { console.error('popups.updatePopupContent failed:', err); }
                } else {
                    console.warn('window.popups.updatePopupContent not available - cannot update/open popup.');
                }
                console.log('Popup should be open now');
            });

            marker.on('mouseover', function(e) { console.log('SeaDot mouseover:', dotData.rfId); });
            return marker;
        }

        createPopupContent(dotData) {
            const statusText = this.getStatusText(dotData.status);
            const helpers = (typeof window !== 'undefined' && window.safePointHelpers) ? window.safePointHelpers : null;
            const resolvedDotColor = (helpers && typeof helpers.getDotColor === 'function') ? (helpers.getDotColor(dotData) || dotData.dotColor) : dotData.dotColor;
            return `
                <div style="color: #333; font-size: 12px; min-width: 220px;">
                    <div style="margin-bottom: 12px;">
                        <strong>座標:</strong> ${dotData.lat.toFixed(3)}°N, ${dotData.lon.toFixed(3)}°E<br>
                        <strong>AIS狀態:</strong> <span style="color: ${resolvedDotColor === 'none' ? '#66e7ff' : resolvedDotColor};">${statusText}</span><br>
                    </div>
                    <div style="background: linear-gradient(135deg, #fef3c7, #fed7aa); padding: 8px; border-radius: 6px; margin-bottom: 12px; border-left: 4px solid #f59e0b;">
                        <div style="text-align: center;">
                            <div style="font-size: 10px; color: #92400e; margin-bottom: 2px;">RF 信號 ID</div>
                            <div style="font-size: 16px; font-weight: bold; color: #92400e; font-family: 'Courier New', monospace;">${dotData.rfId}</div>
                        </div>
                    </div>
                    <div style="margin-top: 10px;">
                        <button onclick="createRFEventfromArea('${dotData.rfId}', '${dotData.lat.toFixed(3)}°N, ${dotData.lon.toFixed(3)}°E')" style="background: #ef4444; color: white; border: none; padding: 4px 8px; margin: 2px; border-radius: 4px; cursor: pointer; font-size: 10px; width: 100%; margin-bottom: 4px;">建立RF監控事件</button>
                    </div>
                </div>
            `;
        }

        changedotColor(dotId, newdotColor) {
            const dotData = this.seaDots.get(dotId);
            if (!dotData) { console.warn(`找不到監測點 ${dotId}`); return false; }
            dotData.dotColor = newdotColor;
            dotData.status = this.getStatusFromColor(newdotColor);
            if (dotData.marker && taiwanMap.hasLayer(dotData.marker)) { taiwanMap.removeLayer(dotData.marker); }
            const newMarker = this.createMarker(dotData);
            dotData.marker = newMarker;
            newMarker.addTo(taiwanMap);
            console.log(`✅ 監測點 ${dotId} 外框顏色已更改為 ${newdotColor}`);
            return true;
        }

        changedotColorBatch(dotIds, newdotColor) {
            let successCount = 0;
            dotIds.forEach(dotId => { if (this.changedotColor(dotId, newdotColor)) successCount++; });
            console.log(`✅ 批量更改完成: ${successCount}/${dotIds.length} 個監測點`);
            return successCount;
        }

        getStatusFromColor(color) {
            switch (color) {
                case '#059669': return 'AIS';
                case '#ef4444': return 'No AIS';
                case '#f59e0b': return 'warning';
                case 'none': return 'unknown';
                default: return 'unknown';
            }
        }

        updateAllSeaDotSizes(map = taiwanMap) {
            if (!map) { console.warn('地圖實例不可用，無法更新 SeaDot 大小'); return; }
            const sizes = calculateSeaDotSize(map);
            let updateCount = 0;
            this.seaDots.forEach((dotData, dotId) => { if (dotData.marker) { updateSeaDotMarkerSize(dotData.marker, sizes, dotData); updateCount++; } });
            console.log(`✅ 已更新 ${updateCount} 個 SeaDot 的大小 (縮放等級: ${map.getZoom()})`);
            return updateCount;
        }

        getStatusText(status) {
            switch (status) {
                case 'AIS': return '已開啟';
                case 'No AIS': return '未開啟';
                case 'unknown': return '狀態未知';
                case 'normal': return '正常監測';
                case 'alert': return '警報狀態';
                case 'warning': return '警告狀態';
                default: return '監測中';
            }
        }

        getColorName(color) {
            switch (color) {
                case '#059669': return '深綠色';
                case '#ef4444': return '紅色';
                case '#f59e0b': return '橙色';
                case 'none': return '無外框';
                default: return '未知';
            }
        }

        hexToRgba(hex, alpha) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        getAreaName(lat, lon) {
            if (lat >= 22.0 && lat <= 25.5 && lon >= 119.0 && lon <= 119.8) return '台灣海峽西側';
            if (lat >= 22.0 && lat <= 25.5 && lon >= 121.5 && lon <= 122.5) return '台灣東部海域';
            if (lat >= 25.0 && lat <= 26.0 && lon >= 120.0 && lon <= 122.0) return '台灣北部海域';
            if (lat >= 21.5 && lat <= 22.5 && lon >= 120.0 && lon <= 121.5) return '台灣南部海域';
            if (lat >= 20.5 && lat <= 22.0 && lon >= 120.5 && lon <= 121.8) return '巴士海峽';
            if (lat >= 23.5 && lat <= 24.5 && lon >= 119.2 && lon <= 119.9) return '台灣海峽中央';
            return '台灣周邊海域';
        }

        getAllDots() { return Array.from(this.seaDots.values()); }
        getAllRFIds() { return this.getAllDots().map(dot => dot.rfId); }
        getDotByRFId(rfId) { return this.getAllDots().find(dot => dot.rfId === rfId); }
        getRFIdsByArea(areaName) { return this.getAllDots().filter(dot => dot.area === areaName).map(dot => dot.rfId); }
        getDotsBydotColor(dotColor) {
            const helpers = (typeof window !== 'undefined' && window.safePointHelpers) ? window.safePointHelpers : null;
            const getDotColor = helpers ? helpers.getDotColor : (p => (p && p.dotColor) || null);
            return this.getAllDots().filter(dot => getDotColor(dot) === dotColor);
        }
        getDotsInRange(latRange, lonRange) {
            try {
                const latMatch = latRange.match(/(\d+\.?\d*)°N\s*-\s*(\d+\.?\d*)°N/);
                const lonMatch = lonRange.match(/(\d+\.?\d*)°E\s*-\s*(\d+\.?\d*)°E/);
                if (!latMatch || !lonMatch) { console.warn('無法解析座標範圍:', { latRange, lonRange }); return []; }
                const latMin = parseFloat(latMatch[1]); const latMax = parseFloat(latMatch[2]);
                const lonMin = parseFloat(lonMatch[1]); const lonMax = parseFloat(lonMatch[2]);
                const dotsInRange = this.getAllDots().filter(dot => dot.lat >= latMin && dot.lat <= latMax && dot.lon >= lonMin && dot.lon <= lonMax);
                console.log(`📍 在範圍 [${latRange}, ${lonRange}] 內找到 ${dotsInRange.length} 個監測點`);
                return dotsInRange;
            } catch (error) { console.error('查詢範圍內監測點時發生錯誤:', error); return []; }
        }

        getDotsInRangeByStatus(latRange, lonRange, status) { return this.getDotsInRange(latRange, lonRange).filter(dot => dot.status === status); }
        getDotsCount() { return this.seaDots.size; }
        clearAllDots() { this.seaDots.forEach(dotData => { if (dotData.marker && taiwanMap.hasLayer(dotData.marker)) { taiwanMap.removeLayer(dotData.marker); } }); this.seaDots.clear(); this.dotIdCounter = 1; console.log('🗑️ 已清除所有海域監測點'); }
    }

    // Export the class
    window.SeaDotManager = SeaDotManager;

    // Helper that will instantiate a single global instance when called.
    function attachIfAvailable() {
        if (window.seaDotManager) return true; // already attached
        if (typeof window.SeaDotManager === 'function') {
            try {
                window.seaDotManager = new window.SeaDotManager();
                console.log('SeaDotManager helper: instantiated and attached window.seaDotManager');
                return true;
            } catch (err) {
                console.warn('SeaDotManager helper: failed to instantiate SeaDotManager', err);
                return false;
            }
        }
        return false; // class not available yet
    }

    window.__attachSeaDotManager = attachIfAvailable;
})();
