// UIUX/ui/popups.js
(function () {
    function createPopupContent(dotData) {
        // Use canonical-safe helpers if available
        const helpers = (window.safePointHelpers || {});
        const getTrackPointData = helpers.getTrackPointData || (p => p || {});
        const getDisplay = helpers.getDisplay || (p => (p && p.display) || {});
    // prefer canonical helper; fallback prefers display.* then legacy color field
    const getDotColor = helpers.getDotColor || (p => (getDisplay(p) && getDisplay(p).dotColor) || (p && p.color) || null);
    const getBackgroundColor = helpers.getBackgroundColor || (p => (getDisplay(p) && getDisplay(p).backgroundColor) || (p && p.backgroundColor) || (p && p.bgColor) || null);

        const tp = getTrackPointData(dotData) || {};
        const disp = getDisplay(dotData) || {};

        const lat = (typeof tp.lat === 'number') ? tp.lat : (tp.latitude || tp.lat || null);
        const lon = (typeof tp.lon === 'number') ? tp.lon : (tp.longitude || tp.lon || null);
        const latStr = (typeof lat === 'number') ? lat.toFixed(3) + '°N' : '未知';
        const lonStr = (typeof lon === 'number') ? lon.toFixed(3) + '°E' : '未知';

        const rawStatus = tp.status || disp.status || dotData.status || '';
        const statusText = (function(s){
            switch(String(s)) {
                case 'AIS': return '已開啟';
                case 'No AIS': return '未開啟';
                case 'unknown': return '狀態未知';
                default: return '監測中';
            }
        })(rawStatus);

    // prefer helper; if helper missing, fallback to display->legacy color->default
    const resolvedColor = (typeof getDotColor === 'function') ? (getDotColor(dotData) || '#666') : '#666';
        const rfId = tp.rfId || dotData.rfId || '';

        return `
            <div style="color: #333; font-size: 12px; min-width: 220px;">
                <div style="margin-bottom: 12px;">
                    <strong>座標:</strong> ${latStr}, ${lonStr}<br>
                    <strong>AIS狀態:</strong> <span style="color: ${resolvedColor === 'none' ? '#66e7ff' : resolvedColor};">${statusText}</span><br>
                </div>
                <div style="background: linear-gradient(135deg, #fef3c7, #fed7aa); padding: 8px; border-radius: 6px; margin-bottom: 12px; border-left: 4px solid #f59e0b;">
                    <div style="text-align: center;">
                        <div style="font-size: 10px; color: #92400e; margin-bottom: 2px;">RF 信號 ID</div>
                        <div style="font-size: 16px; font-weight: bold; color: #92400e; font-family: 'Courier New', monospace;">
                            ${rfId}
                        </div>
                    </div>
                </div>
                <div style="margin-top: 10px;">
                    <button onclick="createRFEventfromArea('${dotData.rfId}', '${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E')" style="background: #ef4444; color: white; border: none; padding: 4px 8px; margin: 2px; border-radius: 4px; cursor: pointer; font-size: 10px; width: 100%; margin-bottom: 4px;">建立RF監控事件</button>
                </div>
            </div>
        `;
    }

    function updatePopupContent(marker, dotData) {
        const content = createPopupContent(dotData);
        if (marker.getPopup()) {
            marker.setPopupContent(content);
        } else {
            marker.bindPopup(content);
        }
    }

    function createTrackPointPopupContent(trackPointData, taskStatus, vesselId) {
        // Use canonical-safe helpers if available
        const helpers = (window.safePointHelpers || {});
        const getSafePointId = helpers.getSafePointId || (p => (p && (p.pointId || p.id)) || null);

        const point = trackPointData || {};
        const lat = point.lat || 0;
        const lon = point.lon || 0;
        const latStr = lat.toFixed(6) + '°N';
        const lonStr = lon.toFixed(6) + '°E';
        const formattedTime = point.timestamp ? new Date(point.timestamp).toLocaleString('zh-TW') : '未知時間';
        const hasTask = point.hasTask || false;
        const vesselIdStr = (vesselId || 'UNKNOWN').toString().toUpperCase();

        // Check for linked missions
        const pointId = getSafePointId(point);
        console.log('Popup debug - pointId:', pointId, 'hasTask:', hasTask, 'missionManager available:', !!window.missionTrackManager);

        const linkedMissions = hasTask && window.missionTrackManager ?
            window.missionTrackManager.getLinkedMissions(pointId) : [];

        console.log('Popup debug - linkedMissions.length:', linkedMissions.length);

        // Mission info section
        let missionInfo = '';
        if (linkedMissions.length > 0) {
            const mission = linkedMissions[0];
            const statusColor = mission.status === '已完成' ? '#10b981' :
                               mission.status === '執行任務' ? '#f59e0b' : '#6b7280';
            missionInfo = `
                <div style="background: linear-gradient(135deg, #f0f9ff, #e0f2fe); padding: 10px; border-radius: 6px; margin-bottom: 8px; border-left: 4px solid #0284c7;">
                    <div style="font-size: 11px; color: #0369a1; margin-bottom: 4px;">🚢 ${mission.type}</div>
                    <div style="font-size: 10px; color: #0369a1; margin-bottom: 2px;">
                        <strong>狀態:</strong> <span style="color: ${statusColor}; font-weight: bold;">${mission.status}</span>
                    </div>
                    <div style="font-size: 10px; color: #0369a1; margin-bottom: 2px;">
                        <strong>進度:</strong> ${mission.progress || 0}%
                    </div>
                    <div style="font-size: 10px; color: #0369a1;">
                        <strong>目標:</strong> ${mission.target || 'N/A'}
                    </div>
                </div>
            `;
        }

        // Task info for points without linked missions
        let taskInfo = '';
        if (hasTask && linkedMissions.length === 0) {
            const taskColor = taskStatus === '已完成' ? '#10b981' : '#f59e0b';
            taskInfo = `
                <div style="background: linear-gradient(135deg, #fef3c7, #fed7aa); padding: 8px; border-radius: 6px; margin-bottom: 8px; border-left: 4px solid #f59e0b;">
                    <div style="font-size: 11px; color: #92400e; margin-bottom: 2px;">📋 任務資訊</div>
                    <div style="font-size: 10px; color: #92400e;">
                        <strong>狀態:</strong> <span style="color: ${taskColor}; font-weight: bold;">${taskStatus}</span>
                    </div>
                </div>
            `;
        }

        return `
            <div style="color: #333; font-size: 12px; min-width: 280px; max-width: 320px;">
                <div style="margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;">
                    <strong style="color: #374151;">🚢 ${vesselIdStr} 軌跡點詳情</strong>
                </div>

                ${missionInfo}
                ${taskInfo}

                <div style="margin-bottom: 8px;">
                    <strong>📍 座標:</strong> ${latStr}, ${lonStr}<br>
                    <strong>⏰ 時間:</strong> ${formattedTime}<br>
                    <strong>🚢 狀態:</strong> <span style="color: ${hasTask ? '#f59e0b' : '#10b981'};">${hasTask ? '執行任務中' : '正常航行'}</span>
                </div>

                ${point.speed ? `
                <div style="margin-bottom: 8px; font-size: 11px;">
                    <strong>航行速度:</strong> ${point.speed.toFixed(1)} 節<br>
                    ${point.course ? `<strong>航向:</strong> ${point.course.toFixed(0)}°<br>` : ''}
                    ${point.signalStrength ? `<strong>信號強度:</strong> ${point.signalStrength.toFixed(1)} dBm<br>` : ''}
                </div>
                ` : ''}

                ${linkedMissions.length > 0 ? `
                <div style="margin-top: 10px;">
                    <button onclick="if(window.showMissionDetails) window.showMissionDetails('${linkedMissions[0].missionId}')"
                            style="background: #0284c7; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; width: 100%;">
                        查看任務詳情
                    </button>
                </div>
                ` : ''}
            </div>
        `;
    }

    window.popups = window.popups || {};
    window.popups.createPopupContent = createPopupContent;
    window.popups.createTrackPointPopupContent = createTrackPointPopupContent;
    window.popups.updatePopupContent = updatePopupContent;
})();
