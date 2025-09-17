let currentEventId = 'area-001'; // 預設選中 area-001 事件
let selectedEventType = null;
let selectedAction = null;
let eventCounter = 4;
let missionCounter = 3;
let creatingEventIds = new Set(); // 追蹤正在創建中的事件ID

// 时间轴模式管理
let timelineMode = 'global'; // 'global' 或 'vessel'
let currentTrackingVessel = null; // 当前追踪的船只

// 從事件卡獲取事件ID的輔助函數
function getEventIdFromCard(card) {
    const eventIdElement = card.querySelector('.event-id');
    if (eventIdElement) {
        return eventIdElement.textContent.toLowerCase();
    }
    return null;
}

// Action options
const actionNames = {
        'track': '持續追蹤',
        'satellite': '衛星重拍',
        'notify': '通知單位',
        'uav': 'UAV 派遣'
    };
    
const actionIcons = {
        'track': '🎯',
        'satellite': '🛰️',
        'notify': '📞',
        'uav': '🚁'
    };

// --- Canonical-safe helper functions (used during migration) ---
function getSafePointId(point) {
    if (!point) return null;
    if (point.pointId) return point.pointId;
    if (point.id) return point.id;
    if (point.trackPointData && point.trackPointData.id) return point.trackPointData.id;
    return null;
}

function getTrackPointData(point) {
    if (!point) return null;
    // If the consumer passed in the legacy wrapper (dotData), prefer .trackPointData
    if (point.trackPointData) return point.trackPointData;
    // If it's already a canonical point, return as-is
    return point;
}

function getDisplay(point) {
    const tp = getTrackPointData(point) || {};
    if (tp.display) return tp.display;
    // fallback to legacy top-level fields
    return {
        dotColor: tp.dotColor || tp.color || null,
        backgroundColor: tp.backgroundColor || tp.bgColor || null
    };
}

function getDotColor(point) {
    const disp = getDisplay(point) || {};
    if (disp.dotColor) return disp.dotColor;
    const tp = getTrackPointData(point) || {};
    if (tp.dotColor) return tp.dotColor;
    if (tp.color) return tp.color;
    // Future points default to yellow during migration
    if (tp.type === 'Future') return '#FFD54A';
    // Respect AIS / No AIS status when present
    if (tp.status === 'No AIS' || tp.status === '未開啟' || tp.status === '未開啟') return '#ef4444';
    if (tp.status === 'AIS' || tp.status === '已開啟') return '#059669';
    // fallback default
    return '#2196F3'; // default blue
}

function getBackgroundColor(point) {
    const disp = getDisplay(point) || {};
    if (disp.backgroundColor) return disp.backgroundColor;
    const tp = getTrackPointData(point) || {};
    return tp.backgroundColor || tp.bgColor || null;
}

function getVesselIdString(point) {
    const tp = getTrackPointData(point) || {};
    const id = tp.vesselId || tp.vessel_id || tp.mmsi || tp.imo || 'UNKNOWN';
    return id == null ? 'UNKNOWN' : String(id);
}

// expose helpers for other modules if needed
if (typeof window !== 'undefined') {
    window.safePointHelpers = {
        getSafePointId, getTrackPointData, getDisplay, getDotColor, getBackgroundColor, getVesselIdString
    };
}

// 統一的任務-軌跡點數據管理器
class MissionTrackPointManager {
    constructor() {
        this.missions = new Map();           // 派遣任務
        this.trackPoints = new Map();        // 軌跡點
        this.missionTrackLinks = new Map();  // 任務與軌跡點的關聯
        this.initializeDefaultData();
    }

    // 創建或更新派遣任務
    createMission(missionData) {
        // Support either passing a sourceTrackPoint object or a stable sourceTrackPointId.
        // Normalize to the safe point id for comparison so that missions reuse works
        // even when the point object is re-created during event re-initialization.
        const incomingSourceObj = missionData.sourceTrackPoint || null;
        const incomingSourceIdField = missionData.sourceTrackPointId || null;
        const incomingSourceId = incomingSourceIdField || (incomingSourceObj ? getSafePointId(incomingSourceObj) : null);

        if (incomingSourceId) {
            for (const [mid, m] of this.missions.entries()) {
                const existingSourceId = (m.sourceTrackPointId) || (m.sourceTrackPoint ? getSafePointId(m.sourceTrackPoint) : null);
                if (existingSourceId && existingSourceId === incomingSourceId && m.action === missionData.action && m.type === missionData.type && (m.isScheduled === missionData.isScheduled)) {
                    // update existing mission with latest metadata and return existing id
                    const updated = { ...m, ...missionData, missionId: mid, timestamp: missionData.timestamp || m.timestamp || new Date().toISOString(), sourceTrackPointId: incomingSourceId };
                    // ensure we store a normalized sourceTrackPointId for stable future comparisons
                    delete updated.sourceTrackPoint; // avoid storing object identity
                    this.missions.set(mid, updated);
                    console.log('Reused existing mission for sourceTrackPointId:', mid, incomingSourceId);
                    // ensure linkage
                    if (updated.boundPointId) this.autoLinkTrackPoints(mid);
                    return mid;
                }
            }
        }

        const missionId = missionData.missionId || `MISSION-${++missionCounter}`;
        const mission = {
            ...missionData,
            missionId: missionId,
            timestamp: missionData.timestamp || new Date().toISOString(),
            // prefer storing a stable sourceTrackPointId rather than object identity
            sourceTrackPointId: incomingSourceId || missionData.sourceTrackPointId || null,
            // one-to-one binding: store a single bound track point id
            boundPointId: Array.isArray(missionData.boundPointId) ? (missionData.boundPointId[0] || null) : (missionData.boundPointId || null)
        };

        this.missions.set(missionId, mission);
        console.log('Mission created in manager:', mission);

        // 自動關聯相近時間的軌跡點
        this.autoLinkTrackPoints(missionId);

        return missionId;
    }

    // 創建或更新軌跡點
    createTrackPoint(pointData) {
        // Normalize incoming point into canonical shape if helper exists
        let normalized = pointData;
        try {
            if (typeof createCanonicalPoint === 'function') {
                normalized = createCanonicalPoint(pointData, { legacy: true });
            } else if (pointData && !pointData.pointId) {
                normalized = Object.assign({}, pointData, { pointId: pointData.id || `TRACK-${Date.now()}-${Math.random().toString(16).substr(2,6)}` });
            }
        } catch (err) { console.warn('Normalization failed, using original pointData', err); normalized = pointData; }

        const pointId = normalized.pointId || normalized.id || `TRACK-${Date.now()}-${Math.random().toString(16).substr(2, 6)}`;
        const trackPoint = {
            ...normalized,
            pointId: pointId,
            // normalize legacy array -> single id for boundMissionId
            boundMissionId: Array.isArray(normalized.boundMissionId) ? (normalized.boundMissionId[0] || null) : (normalized.boundMissionId || null)
        };

        this.trackPoints.set(pointId, trackPoint);

        // 自動關聯相近時間的派遣任務
        this.autoLinkMissions(pointId);

        return pointId;
    }

    // 强制建立一對一綁定（missionId <-> pointId）
    bindMissionToPoint(missionId, pointId) {
        const mission = this.missions.get(missionId);
        const point = this.trackPoints.get(pointId);
        if (!mission || !point) return false;

        // If either side already bound to someone else, unbind them first
        if (mission.boundPointId && mission.boundPointId !== pointId) {
            const prevPoint = this.trackPoints.get(mission.boundPointId);
            if (prevPoint) prevPoint.boundMissionId = null;
            this.missionTrackLinks.delete(`${missionId}-${mission.boundPointId}`);
        }
        if (point.boundMissionId && point.boundMissionId !== missionId) {
            const prevMission = this.missions.get(point.boundMissionId);
            if (prevMission) prevMission.boundPointId = null;
            this.missionTrackLinks.delete(`${point.boundMissionId}-${pointId}`);
        }

        mission.boundPointId = pointId;
        point.boundMissionId = missionId;

        // create/update link record
        const linkKey = `${missionId}-${pointId}`;
        this.missionTrackLinks.set(linkKey, {
            missionId, pointId, linkTime: new Date().toISOString(), linkReason: 'explicit_bind'
        });
        return true;
    }

    // 解除單一綁定（missionId 或 pointId 任一存在）
    unbindMissionFromPoint(missionId, pointId) {
        const mission = this.missions.get(missionId);
        const point = this.trackPoints.get(pointId);
        if (mission && mission.boundPointId === pointId) mission.boundPointId = null;
        if (point && point.boundMissionId === missionId) point.boundMissionId = null;
        this.missionTrackLinks.delete(`${missionId}-${pointId}`);
        return true;
    }

    // 公開便利操作
    unbindMission(missionId) { if (!missionId) return false; const mission = this.missions.get(missionId); if (!mission || !mission.boundPointId) return false; return this.unbindMissionFromPoint(missionId, mission.boundPointId); }
    unbindPoint(pointId) { if (!pointId) return false; const point = this.trackPoints.get(pointId); if (!point || !point.boundMissionId) return false; return this.unbindMissionFromPoint(point.boundMissionId, pointId); }

    // 自動關聯軌跡點到任務 (基於時間和位置)
    autoLinkTrackPoints(missionId) {
        const mission = this.missions.get(missionId);
        if (!mission) return;

        const missionTime = new Date(mission.timestamp);
        let linkedCount = 0;

        this.trackPoints.forEach((point, pointId) => {
            const pointTime = new Date(point.timestamp);
            const timeDiff = Math.abs(pointTime - missionTime);

            // 動態時間窗口：根據任務類型調整
            let timeWindow;
            if (mission.action === 'track') {
                timeWindow = 4 * 60 * 60 * 1000; // 持續追蹤：4小時窗口
            } else if (mission.action === 'uav' || mission.action === 'satellite') {
                timeWindow = 1 * 60 * 60 * 1000; // UAV/衛星：1小時窗口
            } else {
                timeWindow = 2 * 60 * 60 * 1000; // 默認：2小時窗口
            }

            // 時間窗口內 + 船舶ID匹配
            const vesselIdMatch = mission.targetVesselId === getVesselIdString(point) ||
                                mission.targetVesselId === 'all' ||
                                (mission.targetInfo && mission.targetInfo.includes(getVesselIdString(point)));

            if (timeDiff <= timeWindow && vesselIdMatch) {

                // Enforce one-to-one binding: skip if the point is already bound to another mission
                if (point.boundMissionId && point.boundMissionId !== missionId) {
                    return; // point already owned
                }
                // Also skip if mission already bound to a different point
                if (mission.boundPointId && mission.boundPointId !== pointId) {
                    return; // mission already has a bound point
                }

                // Establish one-to-one binding
                mission.boundPointId = pointId;
                point.boundMissionId = missionId;

                // 計算關聯強度分數
                const timeScore = Math.max(0, 1 - (timeDiff / timeWindow)); // 時間越近分數越高
                const taskTypeScore = point.hasTask ? 0.3 : 0; // 有任務的軌跡點分數更高
                const typeScore = point.type === 'Future' && mission.isScheduled ? 0.5 :
                                point.type === 'Current' ? 0.8 : 0.2;

                const linkScore = (timeScore * 0.5) + taskTypeScore + (typeScore * 0.2);

                // 建立關聯記錄 (one-to-one)
                this.missionTrackLinks.set(`${missionId}-${pointId}`, {
                    missionId: missionId,
                    pointId: pointId,
                    linkTime: new Date().toISOString(),
                    linkReason: 'auto_time_vessel',
                    timeDifference: timeDiff,
                    linkScore: linkScore,
                    timeWindow: timeWindow
                });

                linkedCount++;
            }
        });

        console.log(`Mission ${missionId} linked to ${linkedCount} track points`);
        return linkedCount;
    }

    // 自動關聯派遣任務到軌跡點
    autoLinkMissions(pointId) {
        const point = this.trackPoints.get(pointId);
        if (!point) return;

        const pointTime = new Date(point.timestamp);
        let linkedCount = 0;

        this.missions.forEach((mission, missionId) => {
            // If mission explicitly references this point by id, bind immediately (highest priority)
            if (mission.sourceTrackPointId && mission.sourceTrackPointId === pointId) {
                // enforce one-to-one binding semantics
                if (!point.boundMissionId || point.boundMissionId === missionId) {
                    point.boundMissionId = missionId;
                    mission.boundPointId = pointId;
                    const linkKey = `${missionId}-${pointId}`;
                    this.missionTrackLinks.set(linkKey, {
                        missionId: missionId,
                        pointId: pointId,
                        linkTime: new Date().toISOString(),
                        linkReason: 'explicit_source_match'
                    });
                    linkedCount++;
                    return; // continue to next mission
                }
            }
            const missionTime = new Date(mission.timestamp);
            const timeDiff = Math.abs(pointTime - missionTime);

            // 動態時間窗口：根據任務類型調整
            let timeWindow;
            if (mission.action === 'track') {
                timeWindow = 4 * 60 * 60 * 1000; // 持續追蹤：4小時窗口
            } else if (mission.action === 'uav' || mission.action === 'satellite') {
                timeWindow = 1 * 60 * 60 * 1000; // UAV/衛星：1小時窗口
            } else {
                timeWindow = 2 * 60 * 60 * 1000; // 默認：2小時窗口
            }

            // 時間窗口內 + 船舶ID匹配
            const vesselIdMatch = mission.targetVesselId === getVesselIdString(point) ||
                                mission.targetVesselId === 'all' ||
                                (mission.targetInfo && mission.targetInfo.includes(getVesselIdString(point)));

            if (timeDiff <= timeWindow && vesselIdMatch) {

                // Enforce one-to-one binding: skip if the point is already bound to another mission
                if (point.boundMissionId && point.boundMissionId !== missionId) {
                    return; // point already owned
                }
                // Also skip if mission already bound to a different point
                if (mission.boundPointId && mission.boundPointId !== pointId) {
                    return; // mission already has a bound point
                }

                // Establish one-to-one binding
                point.boundMissionId = missionId;
                mission.boundPointId = pointId;

                // 計算關聯強度分數
                const timeScore = Math.max(0, 1 - (timeDiff / timeWindow)); // 時間越近分數越高
                const taskTypeScore = point.hasTask ? 0.3 : 0; // 有任務的軌跡點分數更高
                const typeScore = point.type === 'Future' && mission.isScheduled ? 0.5 :
                                point.type === 'Current' ? 0.8 : 0.2;

                const linkScore = (timeScore * 0.5) + taskTypeScore + (typeScore * 0.2);

                // 建立或更新關聯記錄
                const linkKey = `${missionId}-${pointId}`;
                if (!this.missionTrackLinks.has(linkKey)) {
                    this.missionTrackLinks.set(linkKey, {
                        missionId: missionId,
                        pointId: pointId,
                        linkTime: new Date().toISOString(),
                        linkReason: 'auto_time_vessel',
                        timeDifference: timeDiff,
                        linkScore: linkScore,
                        timeWindow: timeWindow
                    });
                }

                linkedCount++;
            }
        });

        console.log(`Track point ${pointId} linked to ${linkedCount} missions`);
        return linkedCount;
    }

    // 獲取任務相關的軌跡點
    getLinkedTrackPoints(missionId) {
        const mission = this.missions.get(missionId);
        if (!mission) return [];

        // one-to-one: return the single bound point as an array (for compatibility)
        if (mission.boundPointId) {
            const p = this.trackPoints.get(mission.boundPointId);
            return p ? [p] : [];
        }
        return [];
    }

    // 獲取軌跡點相關的任務
    getLinkedMissions(pointId) {
        const point = this.trackPoints.get(pointId);
        if (!point) return [];

        // one-to-one: return the single bound mission as an array (for compatibility)
        if (point.boundMissionId) {
            const m = this.missions.get(point.boundMissionId);
            return m ? [m] : [];
        }
        return [];
    }

    initializeDefaultData() {
        // 預設數據初始化邏輯
        console.log('MissionTrackPointManager initialized');
    }
}

// 全域任務軌跡點管理器實例
const missionTrackManager = new MissionTrackPointManager();

// 確保 missionTrackManager 在全域作用域中可用
window.missionTrackManager = missionTrackManager;

// 事件資料儲存結構
class EventDataStorage {
    constructor() {
        this.events = new Map();
        this.initializeDefaultEvents();
    }

    // 初始化預設事件資料
    initializeDefaultEvents() {
        // 為 area-001 事件生成基本區域資訊
        const areaRange = generateRandomSeaAreaRange();
        // const latRange = areaRange.latRange;
        // const lonRange = areaRange.lonRange;
        const latRange = '10.3°N - 18.3°N'
        const lonRange = '109.8°E - 118.2°E'

        // 獲取當前時間作為 createTime
        const currentTime = new Date();
        const createTimeStr = currentTime.toLocaleTimeString('zh-TW', {
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit'
        });

        // 計算監控結束時間（當前時間 + 8 小時）
        const endTime = new Date(currentTime.getTime() + 8 * 60 * 60 * 1000);
        const endTimeStr = endTime.toLocaleTimeString('zh-TW', {
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit'
        });

        this.events.set('area-001', {
            id: 'area-001',
            type: 'area',
            aoiName: '南海海域',
            latRange: latRange,
            lonRange: lonRange,
            monitorHours: '8',
            createTime: createTimeStr,
            monitorTimeRange: `${createTimeStr} - ${endTimeStr}`,
            status: 'investigating'
            // 不包含 rfCandidates 和 rfCandidatesData，將在 getAreaEventDetailsFromStorage 中動態生成
        });

        // 初始化 RF 事件，等待 SeaDotManager 可用後再填入具體資訊
        let rfEventData = {
            id: 'rf-002',
            type: 'rf',
            detectionTime: '13:45',
            createTime: '13:45',
            status: 'analyzed',
            notes: '未知信號源，無 AIS 對應',
            // 暫時使用預設值，稍後會被重新初始化
            rfId: 'SIG-4A7B2C',
            frequency: '162.025 MHz',
            strength: '-47 dBm',
            coordinates: generateSeaCoordinateForEvents()
        };

        this.events.set('rf-002', rfEventData);

        this.events.set('vessel-003', {
            id: 'vessel-003',
            type: 'vessel',
            mmsi: '416123456',
            coordinates: '等待初始化...', // 將通過 reinitializeVesselEvents 設定
            vesselName: '未知船舶',
            riskScore: 85,
            createTime: '12:30',
            status: 'investigating',
            investigationReason: 'AIS 異常關閉，偏離正常航道',
            trackPoints: this.generateSimulatedTrackPoints('cargo')
        });

        this.events.set('vessel-004', {
            id: 'vessel-004',
            type: 'vessel',
            mmsi: '416789012',
            coordinates: '等待初始化...', // 將通過 reinitializeVesselEvents 設定
            vesselName: '漁船阿勇號',
            riskScore: 28,
            createTime: '10:15',
            status: 'completed',
            investigationReason: '定期巡查',
            completedTime: '12:45',
            trackPoints: this.generateSimulatedTrackPoints('fishing')
        });
    }

    // 儲存事件資料
    saveEvent(eventId, eventData) {
        this.events.set(eventId, {
            id: eventId,
            ...eventData,
            updateTime: new Date().toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'})
        });
        console.log(`事件 ${eventId} 已儲存:`, this.events.get(eventId));
    }

    // 取得事件資料
    getEvent(eventId) {
        return this.events.get(eventId) || null;
    }

    // 更新事件資料
    updateEvent(eventId, updates) {
        const existingEvent = this.events.get(eventId);
        if (existingEvent) {
            this.events.set(eventId, {
                ...existingEvent,
                ...updates,
                updateTime: new Date().toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'})
            });
            console.log(`事件 ${eventId} 已更新:`, this.events.get(eventId));
            return true;
        }
        return false;
    }

    // 刪除事件資料
    deleteEvent(eventId) {
        return this.events.delete(eventId);
    }

    // 重新初始化 RF 事件（在 SeaDotManager 可用後調用）
    reinitializeRFEvents() {
        if (typeof window.seaDotManager === 'undefined' || window.seaDotManager.getAllDots().length === 0) {
            console.warn('⚠️ SeaDotManager 仍不可用，跳過 RF 事件重新初始化');
            return;
        }

        // 重新初始化 rf-002 事件
        const existingRfEvent = this.events.get('rf-002');
        if (existingRfEvent) {
            // 從所有 sea dots 中隨機選擇一個
            const allDots = window.seaDotManager.getAllDots();
            const randomDot = allDots[Math.floor(Math.random() * allDots.length)];
            
            // 根據 sea dot 的 dotColor 決定 AIS 狀態 (use helper)
            let aisStatus = '未知';
            const randomDotColor = getDotColor(randomDot);
            if (randomDotColor === '#ef4444' || randomDotColor === 'red') {
                aisStatus = '未開啟';
            } else if (randomDotColor === '#059669' || randomDotColor === 'green') {
                aisStatus = '已開啟';
            }
            // 更新事件資料
            const updatedEventData = {
                ...existingRfEvent,
                rfId: randomDot.rfId,
                coordinates: `${randomDot.lat.toFixed(3)}°N, ${randomDot.lon.toFixed(3)}°E`,
                frequency: '162.025 MHz',
                strength: '-47 dBm',
                aisStatus: aisStatus,
                sourceSeaDot: {
                    id: getSafePointId(randomDot) || randomDot.id,
                    status: randomDot.status,
                    dotColor: (typeof getDotColor === 'function') ? getDotColor(randomDot) : randomDot.dotColor,
                    area: randomDot.area,
                    // canonical display subobject for consumers
                    display: {
                        dotColor: (typeof getDotColor === 'function') ? getDotColor(randomDot) : randomDot.dotColor,
                        backgroundColor: (typeof getBackgroundColor === 'function') ? (getBackgroundColor(randomDot) || randomDot.backgroundColor || ((typeof getDotColor === 'function') ? getDotColor(randomDot) : randomDot.dotColor)) : (randomDot.backgroundColor || ((typeof getDotColor === 'function') ? getDotColor(randomDot) : randomDot.dotColor))
                    }
                }
            };
            
            this.events.set('rf-002', updatedEventData);
            console.log(`✅ RF 事件 rf-002 已重新初始化，使用 sea dot ${randomDot.id}，RF ID: ${randomDot.rfId}，AIS 狀態: ${aisStatus}`);
            
            // 更新事件卡顯示
            this.updateEventCardDisplay('rf-002', updatedEventData);
        }
    }

    // 重新初始化 Vessel 事件（在 SeaDotManager 可用後調用）
    reinitializeVesselEvents(eventid, coordinates) {
        if (typeof window.seaDotManager === 'undefined' || window.seaDotManager.getAllDots().length === 0) {
            console.warn('⚠️ SeaDotManager 仍不可用，跳過 Vessel 事件重新初始化');
            return;
        }

        // 重新初始化 vessel-003 事件
        const existingVesselEvent = this.events.get(eventid);
        if (!existingVesselEvent) return;

        // 從所有 sea dots 中隨機選擇一個
        const allDots = window.seaDotManager.getAllDots();
        const randomDot = allDots[Math.floor(Math.random() * allDots.length)];

        // 根據 sea dot 的顏色決定 AIS 狀態與風險
        const resolvedColor = (typeof getDotColor === 'function') ? getDotColor(randomDot) : (randomDot.dotColor || randomDot.color || null);
        let aisStatus = '未知';
        if (resolvedColor === '#ef4444' || resolvedColor === 'red') {
            aisStatus = '未開啟';
        } else if (resolvedColor === '#059669' || resolvedColor === 'green') {
            aisStatus = '已開啟';
        }

        // 根據 sea dot 狀態調整風險分數和調查原因
        let riskScore = existingVesselEvent.riskScore || 75;
        let investigationReason = existingVesselEvent.investigationReason || 'AIS 異常關閉，偏離正常航道';
        if (resolvedColor === '#ef4444' || resolvedColor === 'red') {
            riskScore = Math.floor(Math.random() * 16) + 70; // 70-85 高風險
            investigationReason = 'AIS 信號異常關閉，船舶行為可疑';
        } else if (resolvedColor === '#059669' || resolvedColor === 'green') {
            riskScore = Math.floor(Math.random() * 26) + 60; // 60-85 中等風險
            investigationReason = '定期監控，船舶位置異常';
        }

        // 更新事件資料
                const updatedEventData = {
            ...existingVesselEvent,
            coordinates: coordinates,
            riskScore: riskScore,
            investigationReason: investigationReason,
            aisStatus: aisStatus,
            sourceSeaDot: {
                id: getSafePointId(randomDot) || randomDot.id,
                status: randomDot.status,
                dotColor: (typeof getDotColor === 'function') ? (resolvedColor || getDotColor(randomDot)) : (resolvedColor || randomDot.dotColor),
                area: randomDot.area,
                // canonical display subobject for consumers
                    display: {
                    dotColor: (typeof getDotColor === 'function') ? (resolvedColor || getDotColor(randomDot)) : (resolvedColor || randomDot.dotColor),
                    backgroundColor: (typeof getBackgroundColor === 'function') ? (getBackgroundColor(randomDot) || randomDot.backgroundColor || resolvedColor || ((typeof getDotColor === 'function') ? getDotColor(randomDot) : randomDot.dotColor)) : (randomDot.backgroundColor || resolvedColor || ((typeof getDotColor === 'function') ? getDotColor(randomDot) : randomDot.dotColor))
                }
            }
        };

        // 對於 vessel-003，我們希望保留預設的軌跡點，不重新生成
        if (existingVesselEvent.id === eventid) {
            updatedEventData.trackPoints = existingVesselEvent.trackPoints;
            console.log(`🔄 為船舶事件 vessel-003 保留了預設的 'cargo' 軌跡點`);
        } else if (!existingVesselEvent.trackPoints || existingVesselEvent.trackPoints.length === 0) {
            updatedEventData.trackPoints = this.generateFixedTrackPoints(existingVesselEvent.id, randomDot.lat, randomDot.lon);
            console.log(`✅ 為重新初始化的船舶事件 ${existingVesselEvent.id} 生成了新的固定軌跡點`);
        } else {
            // 保留現有軌跡點
            updatedEventData.trackPoints = existingVesselEvent.trackPoints;
            console.log(`🔄 為重新初始化的船舶事件 ${existingVesselEvent.id} 保留了現有的軌跡點`);
        }

        this.events.set(eventid, updatedEventData);
        console.log(`✅ Vessel 事件 vessel-003 已重新初始化，使用 sea dot ${randomDot.id}，風險分數: ${riskScore}，AIS 狀態: ${aisStatus}，座標: ${updatedEventData.coordinates}`);
        // 更新事件卡顯示
        this.updateEventCardDisplay(eventid, updatedEventData);
    }

    // 重新初始化 Area 事件（更新監控時間為當前時間）
    reinitializeAreaEvents() {
        // 重新初始化 area-001 事件的時間
        const areaEvent = this.events.get('area-001');
        if (areaEvent) {
            const areaCard = document.querySelector('[onclick*="area-001"]');
            if (areaCard) {
                const eventInfo = areaCard.querySelector('.event-info');
                if (eventInfo) {
                    eventInfo.innerHTML = `
                        監控區域：${areaEvent.aoiName || '南海海域'}<br>
                        監控時間: ${areaEvent.monitorTimeRange || '計算中'}<br>
                    `;
                    console.log('✅ 已更新 area-001 事件卡顯示內容');
                }
            }
        }
    }

    // 更新事件卡的顯示內容
    updateEventCardDisplay(eventId, eventData) {
        // 尋找對應的事件卡
        const eventCards = document.querySelectorAll('.event-card');
        let targetCard = null;
        
        eventCards.forEach(card => {
            const cardEventId = this.getEventIdFromCard(card);
            if (cardEventId === eventId) {
                targetCard = card;
            }
        });
        
        if (!targetCard) {
            console.warn(`找不到事件卡: ${eventId}`);
            return;
        }

        // 根據事件類型更新顯示內容
        if (eventData.type === 'rf') {
            const eventInfoElement = targetCard.querySelector('.event-info');
            if (eventInfoElement) {
                eventInfoElement.innerHTML = `
                    RF 信號 ID: ${eventData.rfId}<br>
                    座標: ${eventData.coordinates}<br>
                `;
                console.log(`✅ 已更新 ${eventId} 事件卡顯示內容`);
            }
        } else if (eventData.type === 'vessel') {
            const eventInfoElement = targetCard.querySelector('.event-info');
            if (eventInfoElement) {
                eventInfoElement.innerHTML = `
                    風險分數: ${eventData.riskScore}<br>
                    座標: ${eventData.coordinates}<br>
                    AIS 狀態: ${eventData.aisStatus || '未知'}
                `;
                console.log(`✅ 已更新 ${eventId} 事件卡顯示內容`);
            }
        }
    }

    // 從事件卡獲取事件ID的輔助方法
    getEventIdFromCard(card) {
        const eventIdElement = card.querySelector('.event-id');
        if (eventIdElement) {
            return eventIdElement.textContent.toLowerCase();
        }
        return null;
    }

    // 取得所有事件
    getAllEvents() {
        return Array.from(this.events.values());
    }

    // 依類型篩選事件
    getEventsByType(type) {
        return Array.from(this.events.values()).filter(event => event.type === type);
    }

    // 檢查事件是否存在
    hasEvent(eventId) {
        return this.events.has(eventId);
    }

    // 取得事件數量
    getEventCount() {
        return this.events.size;
    }
    
    // 檢查vessel事件的軌跡點狀態 (debug用)
    checkVesselTrackPoints(eventId) {
        const event = this.getEvent(eventId);
        if (event && event.type === 'vessel') {
            console.log(`🔍 船舶事件 ${eventId} 的軌跡點狀態:`);
            console.log(`  - 事件類型: ${event.type}`);
            console.log(`  - 座標: ${event.coordinates}`);
            console.log(`  - 軌跡點數量: ${event.trackPoints ? event.trackPoints.length : '未設定'}`);
            if (event.trackPoints && event.trackPoints.length > 0) {
                console.log(`  - 前3個軌跡點:`, event.trackPoints.slice(0, 3));
            }
            return event.trackPoints;
        } else {
            console.warn(`⚠️ 事件 ${eventId} 不存在或不是vessel類型`);
            return null;
        }
    }

    // 匯出事件資料為 JSON
    exportToJSON() {
        return JSON.stringify(Array.from(this.events.entries()), null, 2);
    }

    // 生成固定的軌跡點（用於vessel事件，只生成一次）
    generateFixedTrackPoints(eventId, endLat, endLon) {
        const totalHistoryPoints = 8; // 歷史點數量
        const totalFuturePoints = 4;  // 未來點數量
        const distance = 0.015; // 點之間的固定距離
        const currentTime = new Date();

        let trackPoints = [];
        let previousPoint = { lat: endLat, lon: endLon };

        // 生成歷史點（往過去時間推算）
        for (let i = 0; i < totalHistoryPoints; i++) {
            const angleAwayFromTarget = Math.atan2(previousPoint.lat - endLat, previousPoint.lon - endLon);
            const randomAngleOffset = (Math.random() - 0.5) * (Math.PI / 3);
            const finalAngle = angleAwayFromTarget + randomAngleOffset;

            const newLat = previousPoint.lat + distance * Math.sin(finalAngle);
            const newLon = previousPoint.lon + distance * Math.cos(finalAngle);

            // 歷史點的時間戳：從現在往前推算
            const timestamp = new Date(currentTime.getTime() - (totalHistoryPoints - i) * 45 * 60 * 1000);

            const trackPoint = {
                id: `${eventId}_history_${i}`,
                lat: newLat,
                lon: newLon,
                status: Math.random() < 0.7 ? 'AIS' : 'No AIS',
                type: 'History',
                timestamp: timestamp.toISOString(),
                speed: 8 + Math.random() * 12, // 8-20 節
                signalStrength: -45 - Math.random() * 25, // -45 to -70 dBm
                deviationFromRoute: Math.random() * 3, // 0-3 公里
                inRestrictedZone: Math.random() > 0.95, // 5% 機率
                hasTask: Math.random() > 0.6, // 40% 機率有任務
                taskType: Math.random() > 0.6 ? ['監控任務', '追蹤任務'][Math.floor(Math.random() * 2)] : null,
                taskDescription: Math.random() > 0.6 ? '執行船舶監控和行為分析' : null,
                vesselId: eventId  // 添加船舶ID用於關聯
            };

            // 通過統一管理器創建軌跡點
            missionTrackManager.createTrackPoint(trackPoint);

            trackPoints.unshift(trackPoint);
            previousPoint = { lat: newLat, lon: newLon };
        }

        // 添加當前點
        const currentPoint = {
            id: `${eventId}_current`,
            lat: endLat,
            lon: endLon,
            status: 'AIS',
            type: 'Current',
            timestamp: currentTime.toISOString(),
            speed: 15,
            signalStrength: -50,
            deviationFromRoute: 0,
            inRestrictedZone: false,
            hasTask: true,
            taskType: '當前監控',
            taskDescription: '正在執行實時監控任務',
            vesselId: eventId
        };

        // 通過統一管理器創建軌跡點
        missionTrackManager.createTrackPoint(currentPoint);

        trackPoints.push(currentPoint);

        // 生成未來點（往未來時間推算）
        previousPoint = { lat: endLat, lon: endLon };
        for (let i = 0; i < totalFuturePoints; i++) {
            const angleTowardsFuture = Math.random() * Math.PI * 2; // 隨機方向
            const newLat = previousPoint.lat + distance * Math.sin(angleTowardsFuture);
            const newLon = previousPoint.lon + distance * Math.cos(angleTowardsFuture);

                // 未來點的時間戳：從現在往後推算，使用 3 小時 粒度
                const timestamp = new Date(currentTime.getTime() + (i + 1) * 3 * 60 * 60 * 1000);

            // 為未來點生成多樣化的數據，確保有正常和異常訊號
            const willBeAbnormal = Math.random() < 0.3; // 30% 機率生成異常數據

            const trackPoint = {
                id: `${eventId}_future_${i}`,
                lat: newLat,
                lon: newLon,
                status: 'Predicted',
                type: 'Future',
                timestamp: timestamp.toISOString(),
                speed: willBeAbnormal ? (Math.random() > 0.5 ? 30 + Math.random() * 10 : Math.random() * 2) : (12 + Math.random() * 8), // 異常：超高速或超低速，正常：12-20節
                signalStrength: willBeAbnormal ? (-80 - Math.random() * 20) : (-55 - Math.random() * 15), // 異常：-80 to -100 dBm，正常：-55 to -70 dBm
                deviationFromRoute: willBeAbnormal ? (5 + Math.random() * 5) : (Math.random() * 2), // 異常：5-10公里偏離，正常：0-2公里
                inRestrictedZone: willBeAbnormal && Math.random() > 0.7, // 異常情況下30%機率在禁航區
                hasTask: Math.random() > 0.4, // 60% 機率有排程任務
                taskType: Math.random() > 0.4 ? ['預定追蹤', '巡查任務', '異常調查'][Math.floor(Math.random() * 3)] : null,
                taskDescription: Math.random() > 0.4 ? (willBeAbnormal ? '預計處理異常訊號事件' : '預計執行監控和追蹤任務') : null,
                vesselId: eventId
            };

            // 通過統一管理器創建軌跡點
            missionTrackManager.createTrackPoint(trackPoint);

            trackPoints.push(trackPoint);
            previousPoint = { lat: newLat, lon: newLon };
        }

        console.log(`✅ 為船舶事件 ${eventId} 生成了完整的軌跡點 (歷史:${totalHistoryPoints}, 當前:1, 未來:${totalFuturePoints})`);

        // 為軌跡點中的任務創建對應的任務卡片
        this.generateMissionCardsFromTrackPoints(trackPoints, eventId);

        return trackPoints;
    }

    // 為軌跡點中的任務生成對應的任務卡片
    generateMissionCardsFromTrackPoints(trackPoints, eventId) {
        trackPoints.forEach(point => {
            // Include Future points by default (treat as scheduled tasks) or any point that explicitly has a task
            if (point.type === 'Future' || (point.hasTask && point.taskType)) {
                // 將軌跡點任務類型映射到標準行動類型
                let actionType, missionType, actionIcon;

                switch (point.taskType) {
                    case '監控任務':
                    case '追蹤任務':
                    case '當前監控':
                        actionType = 'track';
                        missionType = '持續追蹤';
                        actionIcon = '🎯';
                        break;
                    case '預定追蹤':
                        actionType = 'track';
                        missionType = '持續追蹤';
                        actionIcon = '🎯';
                        break;
                    case '巡查任務':
                        actionType = 'uav';
                        missionType = 'UAV 派遣';
                        actionIcon = '🚁';
                        break;
                    case '異常調查':
                        actionType = 'satellite';
                        missionType = '衛星重拍';
                        actionIcon = '🛰️';
                        break;
                    default:
                        actionType = 'track';
                        missionType = '持續追蹤';
                        actionIcon = '🎯';
                }

                // 確定任務狀態
                let missionStatus, executionTime;
                const pointTime = new Date(point.timestamp);
                const currentTime = new Date();

                if (point.type === 'History') {
                    missionStatus = '已完成';
                    executionTime = pointTime;
                } else if (point.type === 'Current') {
                    missionStatus = '執行任務';
                    executionTime = pointTime;
                } else { // Future
                    missionStatus = '派遣';
                    executionTime = pointTime;
                }

                // 創建任務資料
                const missionData = {
                    action: actionType,
                    type: missionType,
                    actionName: missionType,
                    actionIcon: actionIcon,
                    target: eventId.toUpperCase(),
                    targetInfo: eventId.toUpperCase(),
                    targetVesselId: eventId,
                    status: missionStatus,
                    startTime: executionTime,
                    scheduledTime: point.type === 'Future' ? executionTime : null,
                    completedTime: point.type === 'History' ? executionTime : null,
                    description: point.taskDescription || `執行${missionType}任務`,
                    progress: point.type === 'History' ? 100 :
                             point.type === 'Current' ? 75 :
                             point.type === 'Future' ? 15 : 0,
                    estimatedCompletion: point.type !== 'History' ? this.formatEstimatedCompletion(executionTime) : null,
                    isScheduled: point.type === 'Future',
                    sourceTrackPointId: getSafePointId(point)  // 標記來源軌跡點的穩定 id
                };

                // 通過統一管理器創建任務（會自動建立與軌跡點的連結）
                const missionId = missionTrackManager.createMission(missionData);

                // 創建任務卡片顯示在任務列表中
                this.createMissionCard(missionId, missionData);

                console.log(`✅ 為軌跡點 ${getSafePointId(point)} 創建了對應的任務卡片: ${missionId} (${missionType})`);
            }
        });
    }

    // 格式化預計完成時間
    formatEstimatedCompletion(executionTime) {
        const estimatedEnd = new Date(executionTime.getTime() + 2 * 60 * 60 * 1000); // 加2小時
        return estimatedEnd.toLocaleString('zh-TW').split(' ')[1]; // 只返回時間部分
    }

    // 創建任務卡片
    createMissionCard(missionId, missionData) {
        const missionTimeline = document.querySelector('.mission-list');

        if (!missionTimeline) {
            console.warn('找不到任務列表容器，無法添加軌跡點任務');
            return;
        }

        const newMission = document.createElement('div');
        newMission.className = 'mission-card';
        newMission.setAttribute('data-mission-id', missionId);

        // 狀態樣式映射
        const statusClass = missionData.status === '已完成' ? 'status-completed' :
                           missionData.status === '執行任務' ? 'status-executing' :
                           missionData.status === '派遣' ? 'status-dispatched' : 'status-scheduled';

        const progressText = missionData.status === '已完成' ? '已完成 | 任務結束' :
                            missionData.estimatedCompletion ? `進度: ${missionData.progress}% | 預計 ${missionData.estimatedCompletion} 完成` :
                            `進度: ${missionData.progress}%`;

        newMission.innerHTML = `
            <div class="mission-card-header">
                <span class="mission-type">${missionData.actionIcon} ${missionData.type}</span>
                <span class="mission-status ${statusClass}">${missionData.status}</span>
            </div>
            <div class="mission-details">
                目標: ${missionData.target}<br>
                ${missionData.scheduledTime ? '排程: ' + new Date(missionData.scheduledTime).toLocaleString('zh-TW') :
                  missionData.completedTime ? '完成: ' + new Date(missionData.completedTime).toLocaleString('zh-TW') :
                  '開始: ' + new Date(missionData.startTime).toLocaleString('zh-TW')}
            </div>
            <div class="mission-progress">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${missionData.progress}%"></div>
                </div>
                <div class="progress-text">${progressText}</div>
            </div>
        `;

        // 添加點擊事件
        newMission.addEventListener('click', () => {
            highlightMissionCard(missionId);
            showMissionDetails(missionId);
        });
        newMission.style.cursor = 'pointer';

        // 添加到任務列表
        missionTimeline.appendChild(newMission);

        // 更新任務統計
        this.updateMissionStats();
    }

    // 更新任務統計顯示
    updateMissionStats() {
        const stats = document.querySelector('.mission-stats');
        if (stats) {
            const allMissions = document.querySelectorAll('.mission-card');
            const activeMissions = document.querySelectorAll('.mission-card .status-executing, .mission-card .status-dispatched');
            const completedMissions = document.querySelectorAll('.mission-card .status-completed');

            const activeCount = activeMissions.length;
            const completedCount = completedMissions.length;
            const totalCount = allMissions.length;

            stats.textContent = `進行中: ${activeCount} | 已完成: ${completedCount} | 總計: ${totalCount}`;
        }
    }

    generateSimulatedTrackPoints(shiptype) {
        // 重要時間點（小時） - 與船舶軌跡檢視選項對齊
        const importantHours = [120, 96, 72, 48, 24, 12, 6, 3, 0]; // 從遠到近
        const currentTime = new Date();

        // 原始完整軌跡點（保持海上路徑）
        const originalTracks = {
            fishing: [
                { lat: 13.065024737368468, lon: 100.88090895915349, status: 'No AIS', type: 'History' },
                { lat: 13.000274575678905, lon: 100.63231885460398, status: 'AIS', type: 'History' },
                { lat: 12.816402143655235, lon: 100.5121559365818, status: 'AIS', type: 'History' },
                { lat: 12.571080679019152, lon: 100.50425939609092, status: 'AIS', type: 'History' },
                { lat: 12.324903411797516, lon: 100.50218669608854, status: 'AIS', type: 'History' },
                { lat: 12.079209540435095, lon: 100.53994443783212, status: 'AIS', type: 'History' },
                { lat: 11.838564979506009, lon: 100.61532618471438, status: 'AIS', type: 'History' },
                { lat: 11.595921651696361, lon: 100.6995829893499, status: 'AIS', type: 'History' },
                { lat: 11.357115194893014, lon: 100.77116570550932, status: 'AIS', type: 'History' },
                { lat: 11.113960749210412, lon: 100.83891824077482, status: 'AIS', type: 'History' },
                { lat: 10.8673633245079, lon: 100.89517763508664, status: 'AIS', type: 'History' },
                { lat: 10.624637775543771, lon: 100.95295236414975, status: 'AIS', type: 'History' },
                { lat: 10.386668619906004, lon: 101.00788406433297, status: 'AIS', type: 'History' },
                { lat: 10.153428941718284, lon: 101.08527123008167, status: 'AIS', type: 'History' },
                { lat: 9.919501284560454, lon: 101.14142595014616, status: 'AIS', type: 'History' },
                { lat: 9.686552954112068, lon: 101.249610777446, status: 'AIS', type: 'History' },
                { lat: 9.453197432694445, lon: 101.35121818466139, status: 'AIS', type: 'History' },
                { lat: 9.241517555306238, lon: 101.47854801642463, status: 'AIS', type: 'History' },
                { lat: 9.044925821306041, lon: 101.63235660176852, status: 'AIS', type: 'History' },
                { lat: 8.871288743941548, lon: 101.79989808724271, status: 'AIS', type: 'History' },
                { lat: 8.708429323113009, lon: 101.98117253242822, status: 'No AIS', type: 'History' },
                { lat: 8.280283102901367, lon: 102.31076272747136, status: 'AIS', type: 'History' },
                { lat: 7.908630578369372, lon: 102.68979130883962, status: 'AIS', type: 'History' },
                { lat: 7.699107852709557, lon: 103.1580781209581, status: 'AIS', type: 'History' },
                { lat: 7.656917520404703, lon: 103.67168887831085, status: 'AIS', type: 'History' },
                { lat: 7.670527763959799, lon: 104.18392641721015, status: 'AIS', type: 'History' },
                { lat: 7.686859486142251, lon: 104.70028382250284, status: 'AIS', type: 'History' },
                { lat: 7.700468772482115, lon: 105.21664126993089, status: 'AIS', type: 'History' },
                { lat: 7.813408916041465, lon: 105.72063906987891, status: 'AIS', type: 'History' },
                { lat: 8.031038285117381, lon: 106.19305120263223, status: 'AIS', type: 'History' },
                { lat: 8.26485976562018, lon: 106.64349063074788, status: 'AIS', type: 'History' },
                { lat: 8.55286733034221, lon: 107.07745058407386, status: 'AIS', type: 'History' },
                { lat: 8.862368303516716, lon: 107.48943789229526, status: 'AIS', type: 'History' },
                { lat: 9.171608819247808, lon: 107.91790468128688, status: 'AIS', type: 'History' },
                { lat: 9.46432529073659, lon: 108.32989200636246, status: 'AIS', type: 'History' },
                { lat: 9.753328313719159, lon: 108.76203689205124, status: 'AIS', type: 'History' },
                { lat: 9.991188185339132, lon: 109.22168277370157, status: 'AIS', type: 'History' },
                { lat: 10.277783068609828, lon: 109.64465641521295, status: 'AIS', type: 'History' },
                { lat: 10.585717713716969, lon: 110.06213688287559, status: 'AIS', type: 'History' },
                { lat: 10.91426743488117, lon: 110.46481325514617, status: 'AIS', type: 'History' },
                { lat: 11.219539201383867, lon: 110.88169816961447, status: 'AIS', type: 'History' },
                { lat: 11.583010239082498, lon: 111.25248684400674, status: 'AIS', type: 'Current' },
                { lat: 11.932573485988403, lon: 111.63151512843621, status: 'AIS', type: 'Future' },
                { lat: 12.303241453667606, lon: 111.994063924348039, status: 'AIS', type: 'Future' },
                { lat: 12.662152122618157, lon: 112.372582797518023, status: 'AIS', type: 'Future' },
                { lat: 13.021062791568709, lon: 112.751101670687994, status: 'AIS', type: 'Future' },
            ],
            cargo: [
                { lat: 13.079972, lon: 100.881889, status: 'AIS', type: 'History' },
                { lat: 12.97356780985889, lon: 100.54796015066181, status: 'AIS', type: 'History' },
                { lat: 12.627365165638585, lon: 100.5183255489848, status: 'AIS', type: 'History' },
                { lat: 12.294899757342149, lon: 100.63181824151971, status: 'AIS', type: 'History' },
                { lat: 11.959388784241828, lon: 100.73584594897854, status: 'AIS', type: 'History' },
                { lat: 11.624033620715302, lon: 100.8408536314547, status: 'AIS', type: 'History' },
                { lat: 11.290293043547429, lon: 100.95037637682013, status: 'AIS', type: 'History' },
                { lat: 10.950410139667289, lon: 101.04147669607556, status: 'AIS', type: 'History' },
                { lat: 10.61370150020552, lon: 101.14027687780214, status: 'AIS', type: 'History' },
                { lat: 10.276384320786649, lon: 101.23959290101489, status: 'AIS', type: 'History' },
                { lat: 9.945337945778036, lon: 101.35912969606814, status: 'AIS', type: 'History' },
                { lat: 9.632287811383744, lon: 101.51504149771144, status: 'AIS', type: 'History' },
                { lat: 9.316768552457347, lon: 101.66819373134327, status: 'AIS', type: 'History' },
                { lat: 9.00675534249025, lon: 101.83129364636173, status: 'AIS', type: 'History' },
                { lat: 8.708980846830958, lon: 102.01497576722561, status: 'No AIS', type: 'History' },
                { lat: 8.236609309971005, lon: 102.5366310292528, status: 'AIS', type: 'History' },
                { lat: 7.835845713410455, lon: 103.11140299233783, status: 'AIS', type: 'History' },
                { lat: 7.457628329258875, lon: 103.70157653136624, status: 'AIS', type: 'History' },
                { lat: 7.100633868023333, lon: 104.30462496420537, status: 'AIS', type: 'History' },
                { lat: 7.032230328649701, lon: 105.00267803367264, status: 'AIS', type: 'History' },
                { lat: 7.235773141144987, lon: 105.67856270607956, status: 'AIS', type: 'History' },
                { lat: 7.605449764946292, lon: 106.28065290350045, status: 'AIS', type: 'History' },
                { lat: 7.979300897444996, lon: 106.87842685916733, status: 'AIS', type: 'History' },
                { lat: 8.36958795786419, lon: 107.46668599882994, status: 'AIS', type: 'History' },
                { lat: 8.779606461892143, lon: 108.0425362884556, status: 'AIS', type: 'History' },
                { lat: 9.196068638831276, lon: 108.61429142368263, status: 'AIS', type: 'History' },
                { lat: 9.609274284007839, lon: 109.1880940674801, status: 'AIS', type: 'History' },
                { lat: 10.004053265017374, lon: 109.77607205868364, status: 'AIS', type: 'History' },
                { lat: 10.48668008138099, lon: 110.2909514532092, status: 'AIS', type: 'History' },
                { lat: 10.945439335635449, lon: 110.83386503799089, status: 'AIS', type: 'History' },
                { lat: 11.424433821583277, lon: 111.3552892345447, status: 'AIS', type: 'History' },
                { lat: 11.906593207781603, lon: 111.86725860015174, status: 'AIS', type: 'History' },
                { lat: 12.378587261222078, lon: 112.38653028623536, status: 'AIS', type: 'History' },
                { lat: 12.880028572978512, lon: 112.89285140752781, status: 'AIS', type: 'History' },
                { lat: 13.346365161153159, lon: 113.42666419107641, status: 'AIS', type: 'History' },
                { lat: 13.843548982024831, lon: 113.90005561847288, status: 'AIS', type: 'History' },
                { lat: 14.393700198895079, lon: 114.35816488660092, status: 'AIS', type: 'History' },
                { lat: 14.98008563349693, lon: 114.75870448890798, status: 'AIS', type: 'History' },
                { lat: 15.566967705180106, lon: 115.16245207707092, status: 'AIS', type: 'History' },
                { lat: 16.166689259314516, lon: 115.54148037473821, status: 'AIS', type: 'History' },
                { lat: 16.797148432659423, lon: 115.85021334874027, status: 'AIS', type: 'Current' },
                { lat: 17.430319477341907, lon: 116.15733958244417, status: 'AIS', type: 'Future' },
                { lat: 18.05449729960005, lon: 116.4930219751414, status: 'AIS', type: 'Future' },
                { lat: 18.69907628485336, lon: 116.78243874920335, status: 'AIS', type: 'Future' },
                { lat: 19.344809349959917, lon: 117.07381239505587, status: 'AIS', type: 'Future' },
            ]
        };

        const allOriginalPoints = originalTracks[shiptype] || originalTracks.cargo;
        const trackData = [];

        // 從原始軌跡點中選擇對應重要時間點的點
        // 重要時間點：[120, 96, 72, 48, 24, 12, 6, 3, 0] 小時前
        importantHours.forEach((hours, index) => {
            let selectedPoint;

            if (hours === 0) {
                // 當前點：選擇type為'Current'的點
                selectedPoint = allOriginalPoints.find(p => p.type === 'Current');
            } else {
                // 歷史點：根據時間間隔選擇點
                // 將120-0小時的範圍映射到歷史點的索引
                const historyPoints = allOriginalPoints.filter(p => p.type === 'History');
                const pointIndex = Math.floor(((120 - hours) / 120) * (historyPoints.length - 1));
                selectedPoint = historyPoints[pointIndex];
            }

            if (selectedPoint) {
                // 正確計算時間戳：當前時間減去對應的小時數
                const timestamp = new Date(currentTime.getTime() - hours * 60 * 60 * 1000);
                const willBeAbnormal = (hours === 48 || hours === 72) || Math.random() < 0.15;
                const speed = willBeAbnormal ?
                    (Math.random() > 0.5 ? 28 + Math.random() * 12 : Math.random() * 3) :
                    (8 + Math.random() * 15);

                const trackPoint = {
                    ...selectedPoint,
                    id: `${shiptype}_${hours}h_${index + 1}`,
                    timestamp: timestamp.toISOString(),
                    speed: speed,
                    signalStrength: willBeAbnormal ? (-85 - Math.random() * 15) : (-45 - Math.random() * 35),
                    deviationFromRoute: willBeAbnormal ? (6 + Math.random() * 8) : (Math.random() * 4),
                    inRestrictedZone: willBeAbnormal && Math.random() > 0.8,
                    hasTask: true, // 確保每個點都有任務
                    course: 45 + Math.random() * 90,
                    reportTime: timestamp.toLocaleTimeString('zh-TW', {hour12: false}),
                    taskType: willBeAbnormal ?
                        ['異常調查', '緊急追蹤', '威脅評估'][Math.floor(Math.random() * 3)] :
                        ['監控任務', '追蹤任務', '偵察任務'][Math.floor(Math.random() * 3)],
                    taskDescription: willBeAbnormal ?
                        '處理異常行為和信號異常事件' :
                        '執行船舶監控和行為分析'
                };

                // 通過統一管理器創建軌跡點
                missionTrackManager.createTrackPoint(trackPoint);

                // 為軌跡點創建對應的派遣任務
                const missionTypes = ['UAV 派遣', '衛星重拍', '持續追蹤', '聯繫船隻'];
                const missionType = missionTypes[Math.floor(Math.random() * missionTypes.length)];
                const missionData = {
                    type: missionType,
                    action: missionType === 'UAV 派遣' ? 'uav' :
                           missionType === '衛星重拍' ? 'satellite' :
                           missionType === '聯繫船隻' ? 'notify' : 'track',
                    target: `${shiptype} 船隻 - ${trackPoint.lat.toFixed(4)}°N ${trackPoint.lon.toFixed(4)}°E`,
                    status: trackPoint.type === 'History' ? '已完成' :
                           trackPoint.type === 'Current' ? '執行任務' : '排程',
                    progress: trackPoint.type === 'History' ? 100 :
                             trackPoint.type === 'Current' ? 75 : 25,
                    description: `${missionType}任務 - 監控目標船隻活動`,
                    estimatedCompletion: trackPoint.type !== 'History' ?
                        new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleTimeString('zh-TW', {hour12: false}) : null,
                    sourceTrackPointId: trackPoint.id
                };

                const missionId = missionTrackManager.createMission(missionData);

                // 建立軌跡點與任務的雙向連結
                const managedPoint = missionTrackManager.trackPoints.get(trackPoint.id);
                const managedMission = missionTrackManager.missions.get(missionId);
                if (managedPoint && managedMission) {
                    managedPoint.boundMissionId = missionId;
                    managedMission.boundPointId = trackPoint.id;
                }

                trackData.push(trackPoint);
            }
        });

        // 添加未來點
        const futurePoints = allOriginalPoints.filter(p => p.type === 'Future');
        futurePoints.slice(0, 3).forEach((point, index) => {
            const hours = (index + 1) * 3; // 3, 6, 9小時後
            const timestamp = new Date(currentTime.getTime() + hours * 60 * 60 * 1000);

            const futureTrackPoint = {
                ...point,
                id: `${shiptype}_future_${hours}h`,
                timestamp: timestamp.toISOString(),
                speed: 12 + Math.random() * 8,
                signalStrength: -50 - Math.random() * 25,
                deviationFromRoute: Math.random() * 3,
                inRestrictedZone: false,
                hasTask: true, // 確保每個點都有任務
                course: 45 + Math.random() * 90,
                reportTime: timestamp.toLocaleTimeString('zh-TW', {hour12: false}),
                taskType: ['監控任務', '追蹤任務', '偵察任務'][Math.floor(Math.random() * 3)],
                taskDescription: '執行船舶監控和行為分析'
            };

            // 通過統一管理器創建軌跡點
            missionTrackManager.createTrackPoint(futureTrackPoint);

            // 為未來軌跡點創建對應的派遣任務
            const futureMissionTypes = ['UAV 派遣', '衛星重拍', '持續追蹤', '聯繫船隻'];
            const futureMissionType = futureMissionTypes[Math.floor(Math.random() * futureMissionTypes.length)];
            const futureMissionData = {
                type: futureMissionType,
                action: futureMissionType === 'UAV 派遣' ? 'uav' :
                       futureMissionType === '衛星重拍' ? 'satellite' :
                       futureMissionType === '聯繫船隻' ? 'notify' : 'track',
                target: `${shiptype} 船隻 - ${futureTrackPoint.lat.toFixed(4)}°N ${futureTrackPoint.lon.toFixed(4)}°E`,
                status: '排程',
                progress: 0,
                description: `${futureMissionType}任務 - 預定監控目標船隻活動`,
                estimatedCompletion: new Date(timestamp.getTime() + 2 * 60 * 60 * 1000).toLocaleTimeString('zh-TW', {hour12: false}),
                sourceTrackPointId: futureTrackPoint.id,
                scheduledTime: timestamp.toISOString()
            };

            const futureMissionId = missionTrackManager.createMission(futureMissionData);

            // 建立軌跡點與任務的雙向連結
            const managedFuturePoint = missionTrackManager.trackPoints.get(futureTrackPoint.id);
            const managedFutureMission = missionTrackManager.missions.get(futureMissionId);
            if (managedFuturePoint && managedFutureMission) {
                managedFuturePoint.boundMissionId = futureMissionId;
                managedFutureMission.boundPointId = futureTrackPoint.id;
            }

            trackData.push(futureTrackPoint);
        });

        return trackData;
    }

    // 根據船隻 MMSI 查找事件資料
    getEventByShipInfoMMSI(mmsi) {
        for (const [eventId, eventData] of this.events) {
            if (eventData.shipInfo.mmsi === mmsi) {
                return eventData;
            }
            else {
                console.log(`Event ${eventId} does not match MMSI ${mmsi}`);
            }
        }
        return null;
    }

    // 從 JSON 匯入事件資料
    importFromJSON(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            this.events = new Map(data);
            return true;
        } catch (error) {
            console.error('匯入事件資料失敗:', error);
            return false;
        }
    }
}

// 建立全域事件資料儲存實例
const eventStorage = new EventDataStorage();

// 全域測試函數 - 檢查vessel事件的軌跡點 (開發/測試用)
window.checkVesselTracks = function(eventId) {
    if (eventId) {
        return eventStorage.checkVesselTrackPoints(eventId);
    } else {
        // 如果沒有指定ID，檢查所有vessel事件
        console.log('🔍 檢查所有vessel事件的軌跡點狀態：');
        const vesselEvents = eventStorage.getEventsByType('vessel');
        vesselEvents.forEach(event => {
            console.log(`  - ${event.id}: ${event.trackPoints ? event.trackPoints.length : '未設定'} 個軌跡點`);
        });
        return vesselEvents.map(event => ({
            id: event.id,
            trackPointsCount: event.trackPoints ? event.trackPoints.length : 0
        }));
    }
};

// 全域測試函數 - 強制為vessel事件重新生成軌跡點 (開發/測試用)
window.regenerateVesselTracks = function(eventId) {
    const event = eventStorage.getEvent(eventId);
    if (event && event.type === 'vessel' && event.coordinates) {
        try {
            const coords = parsePointCoordinates(event.coordinates);
            if (coords) {
                const newTrackPoints = eventStorage.generateFixedTrackPoints(eventId, coords.lat, coords.lon);
                eventStorage.updateEvent(eventId, { trackPoints: newTrackPoints });
                console.log(`✅ 已為船舶事件 ${eventId} 重新生成了 ${newTrackPoints.length} 個軌跡點`);
                return newTrackPoints;
            }
        } catch (error) {
            console.error(`❌ 重新生成軌跡點時發生錯誤:`, error);
        }
    } else {
        console.warn(`⚠️ 事件 ${eventId} 不存在、不是vessel類型或缺少座標`);
    }
    return null;
};

// 全域海域座標生成函數（避開台灣本島）
function generateSeaCoordinateForEvents() {
    // 定義台灣本島的大致範圍（避免在陸地上放置事件）
    const taiwanLandAreas = [
        // 台灣本島主要區域
        { latMin: 21.9, latMax: 25.3, lonMin: 120.0, lonMax: 122.0 },
    ];
    
    // 定義海域範圍（台灣周圍海域）
    const seaAreas = [
        // 台灣海峽西側
        { latMin: 22.0, latMax: 25.5, lonMin: 119.0, lonMax: 119.8, name: '台灣海峽西側' },
        // 東部海域
        { latMin: 22.0, latMax: 25.5, lonMin: 121.5, lonMax: 122.5, name: '台灣東部海域' },
        // 北部海域
        { latMin: 25.0, latMax: 26.0, lonMin: 120.0, lonMax: 122.0, name: '台灣北部海域' },
        // 南部海域
        { latMin: 21.5, latMax: 22.5, lonMin: 120.0, lonMax: 121.5, name: '台灣南部海域' },
        // 巴士海峽
        { latMin: 20.5, latMax: 22.0, lonMin: 120.5, lonMax: 121.8, name: '巴士海峽' },
        // 台灣海峽中央
        { latMin: 23.5, latMax: 24.5, lonMin: 119.2, lonMax: 119.9, name: '台灣海峽中央' }
    ];
    
    // 檢查座標是否在台灣陸地範圍內
    function isOnLand(lat, lon) {
        return taiwanLandAreas.some(area => 
            lat >= area.latMin && lat <= area.latMax && 
            lon >= area.lonMin && lon <= area.lonMax
        );
    }
    
    const maxAttempts = 20;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
        // 隨機選擇一個海域
        const seaArea = seaAreas[Math.floor(Math.random() * seaAreas.length)];
        
        // 在該海域內生成隨機座標
        const lat = seaArea.latMin + Math.random() * (seaArea.latMax - seaArea.latMin);
        const lon = seaArea.lonMin + Math.random() * (seaArea.lonMax - seaArea.lonMin);
        
        // 檢查是否在陸地上
        if (!isOnLand(lat, lon)) {
            // 格式化為度分格式字串
            const latStr = `${lat.toFixed(3)}°N`;
            const lonStr = `${lon.toFixed(3)}°E`;
            return `${latStr}, ${lonStr}`;
        }
        
        attempts++;
    }
    
    // 如果多次嘗試都失敗，使用預設的海域座標
    return '24.000°N, 119.500°E';
}

// 隨機生成台灣周遭海域的座標範圍
function generateRandomSeaAreaRange() {
    // 定義台灣周遭各個海域的基本範圍
    const seaRegions = [
        {
            name: '台灣海峽西側',
            latBase: { min: 22.0, max: 25.5 },
            lonBase: { min: 119.0, max: 119.8 },
            sizeRange: { min: 0.3, max: 1.2 } // 範圍大小（度數）
        },
        {
            name: '台灣東部海域',
            latBase: { min: 22.0, max: 25.5 },
            lonBase: { min: 121.5, max: 122.5 },
            sizeRange: { min: 0.4, max: 1.0 }
        },
        {
            name: '台灣北部海域',
            latBase: { min: 25.0, max: 26.0 },
            lonBase: { min: 120.0, max: 122.0 },
            sizeRange: { min: 0.3, max: 0.8 }
        },
        {
            name: '台灣南部海域',
            latBase: { min: 21.5, max: 22.5 },
            lonBase: { min: 120.0, max: 121.5 },
            sizeRange: { min: 0.4, max: 0.9 }
        },
        {
            name: '巴士海峽',
            latBase: { min: 20.5, max: 22.0 },
            lonBase: { min: 120.5, max: 121.8 },
            sizeRange: { min: 0.5, max: 1.1 }
        },
        {
            name: '台灣海峽中央',
            latBase: { min: 23.5, max: 24.5 },
            lonBase: { min: 119.2, max: 119.9 },
            sizeRange: { min: 0.3, max: 0.7 }
        }
    ];

    // 隨機選擇一個海域
    const selectedRegion = seaRegions[Math.floor(Math.random() * seaRegions.length)];
    
    // 生成範圍大小
    const latSize = selectedRegion.sizeRange.min + Math.random() * (selectedRegion.sizeRange.max - selectedRegion.sizeRange.min);
    const lonSize = selectedRegion.sizeRange.min + Math.random() * (selectedRegion.sizeRange.max - selectedRegion.sizeRange.min);
    
    // 在選定海域內隨機選擇一個起始點，確保範圍不會超出海域邊界
    const maxLatStart = selectedRegion.latBase.max - latSize;
    const maxLonStart = selectedRegion.lonBase.max - lonSize;
    
    const latStart = selectedRegion.latBase.min + Math.random() * (maxLatStart - selectedRegion.latBase.min);
    const lonStart = selectedRegion.lonBase.min + Math.random() * (maxLonStart - selectedRegion.lonBase.min);
    
    // 計算範圍終點
    const latEnd = latStart + latSize;
    const lonEnd = lonStart + lonSize;
    
    // 格式化範圍字串
    const latRange = `${latStart.toFixed(1)}°N - ${latEnd.toFixed(1)}°N`;
    const lonRange = `${lonStart.toFixed(1)}°E - ${lonEnd.toFixed(1)}°E`;
    
    console.log(`🌊 生成 ${selectedRegion.name} 座標範圍: ${latRange}, ${lonRange}`);
    
    return {
        latRange: latRange,
        lonRange: lonRange,
        areaName: selectedRegion.name,
        centerLat: (latStart + latEnd) / 2,
        centerLon: (lonStart + lonEnd) / 2,
        size: Math.max(latSize, lonSize)
    };
}

// 從座標範圍內生成隨機座標（兼容舊函數調用）
function generateCoordinatesInRange(latRange, lonRange) {
    try {
        // 如果沒有提供參數，使用新的隨機海域範圍生成
        if (!latRange || !lonRange) {
            const randomRange = generateRandomSeaAreaRange();
            latRange = randomRange.latRange;
            lonRange = randomRange.lonRange;
        }
        
        // 解析緯度範圍 (支持混合方向，例: "24.2°N - 24.8°S")
        const latMatch = latRange.match(/(\d+\.?\d*)°([NS])\s*-\s*(\d+\.?\d*)°([NS])/);
        const lonMatch = lonRange.match(/(\d+\.?\d*)°([EW])\s*-\s*(\d+\.?\d*)°([EW])/);
        
        if (latMatch && lonMatch) {
            let latMin = parseFloat(latMatch[1]);
            let latMax = parseFloat(latMatch[3]);
            let lonMin = parseFloat(lonMatch[1]);
            let lonMax = parseFloat(lonMatch[3]);
            
            // 處理南緯：將南緯轉換為負數
            if (latMatch[2] === 'S') latMin = -latMin;
            if (latMatch[4] === 'S') latMax = -latMax;
            
            // 處理西經：將西經轉換為負數
            if (lonMatch[2] === 'W') lonMin = -lonMin;
            if (lonMatch[4] === 'W') lonMax = -lonMax;
            
            // 確保 min <= max（如果跨越了0度線，需要特殊處理）
            if (latMin > latMax) {
                const temp = latMin;
                latMin = latMax;
                latMax = temp;
            }
            if (lonMin > lonMax && Math.abs(lonMin - lonMax) < 180) {
                const temp = lonMin;
                lonMin = lonMax;
                lonMax = temp;
            }
            
            // 台灣本島範圍定義
            const taiwanLandAreas = [
                { latMin: 21.9, latMax: 25.3, lonMin: 120.0, lonMax: 122.0 },
            ];
            
            // 檢查座標是否在台灣陸地範圍內
            function isOnLand(lat, lon) {
                // 使用絕對值進行檢查，因為台灣位於北緯東經
                const absLat = Math.abs(lat);
                const absLon = Math.abs(lon);
                return taiwanLandAreas.some(area => 
                    absLat >= area.latMin && absLat <= area.latMax && 
                    absLon >= area.lonMin && absLon <= area.lonMax
                );
            }
            
            const maxAttempts = 30;
            let attempts = 0;
            
            while (attempts < maxAttempts) {
                // 在指定範圍內生成隨機座標
                const lat = latMin + Math.random() * (latMax - latMin);
                const lon = lonMin + Math.random() * (lonMax - lonMin);
                
                // 檢查是否在陸地上
                if (!isOnLand(lat, lon)) {
                    // 格式化為度分格式字串，正確處理南緯和西經
                    const latStr = lat >= 0 ? `${lat.toFixed(3)}°N` : `${Math.abs(lat).toFixed(3)}°S`;
                    const lonStr = lon >= 0 ? `${lon.toFixed(3)}°E` : `${Math.abs(lon).toFixed(3)}°W`;
                    return `${latStr}, ${lonStr}`;
                }
                
                attempts++;
            }
            
            // 如果多次嘗試都失敗，使用範圍邊界的海域座標
            const edgeLat = Math.random() < 0.5 ? latMin : latMax;
            const edgeLon = Math.random() < 0.5 ? lonMin : lonMax;
            const edgeLatStr = edgeLat >= 0 ? `${edgeLat.toFixed(3)}°N` : `${Math.abs(edgeLat).toFixed(3)}°S`;
            const edgeLonStr = edgeLon >= 0 ? `${edgeLon.toFixed(3)}°E` : `${Math.abs(edgeLon).toFixed(3)}°W`;
            return `${edgeLatStr}, ${edgeLonStr}`;
            
        } else {
            // 如果解析失敗，使用海域座標生成函數
            console.warn('無法解析座標範圍，使用海域座標生成');
            return generateSeaCoordinateForEvents();
        }
    } catch (error) {
        console.error('生成座標時發生錯誤:', error);
        return generateSeaCoordinateForEvents();
    }
}

// 計算監控時間範圍的輔助函數（包含日期考量）
function calculateMonitorTimeRange(createTime, monitorHours) {
    if (!createTime || !monitorHours) return '未設定';
    
    try {
        const monitorHoursNum = parseInt(monitorHours);
        if (isNaN(monitorHoursNum) || monitorHoursNum <= 0) return '無效的監控時間';
        
        // 解析建立時間 (格式: HH:MM)
        const [hours, minutes] = createTime.split(':').map(Number);
        const startTime = new Date();
        startTime.setHours(hours, minutes, 0, 0);
        
        // 計算結束時間
        const endTime = new Date(startTime);
        endTime.setTime(startTime.getTime() + (monitorHoursNum * 60 * 60 * 1000));
        
        // 格式化時間的函數
        const formatDateTime = (date) => {
            const today = new Date();
            const tomorrow = new Date(today);
            tomorrow.setDate(today.getDate() + 1);
            const yesterday = new Date(today);
            yesterday.setDate(today.getDate() - 1);
            
            const timeString = date.toLocaleTimeString('zh-TW', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit'
            });
            
            // 檢查是否為今天、明天或昨天
            if (date.toDateString() === today.toDateString()) {
                return timeString; // 只顯示時間
            } else if (date.toDateString() === tomorrow.toDateString()) {
                return `明日 ${timeString}`;
            } else if (date.toDateString() === yesterday.toDateString()) {
                return `昨日 ${timeString}`;
            } else {
                // 顯示完整日期和時間
                const dateString = date.toLocaleDateString('zh-TW', {
                    month: '2-digit',
                    day: '2-digit'
                });
                return `${dateString} ${timeString}`;
            }
        };
        
        const startFormatted = formatDateTime(startTime);
        const endFormatted = formatDateTime(endTime);
        
        // 如果監控時間超過24小時，添加持續時間提示
        let durationHint = '';
        if (monitorHoursNum >= 24) {
            const days = Math.floor(monitorHoursNum / 24);
            const remainingHours = monitorHoursNum % 24;
            if (days > 0 && remainingHours > 0) {
                durationHint = ` (${days}天${remainingHours}小時)`;
            } else if (days > 0) {
                durationHint = ` (${days}天)`;
            }
        }
        
        return `${startFormatted} - ${endFormatted}${durationHint}`;
    } catch (error) {
        console.warn('計算監控時間範圍時發生錯誤:', error);
        return `${createTime} - (${monitorHours || '未設定'})`;
    }
}

// 取得無 AIS 的 RF 信號資料 - 使用 SeaDotManager 整合
function getRFSignalsWithoutAIS(areaEvent) {
    try {
        console.log('🔍 開始查詢無 AIS 的 RF 信號', areaEvent);
        
        if (!areaEvent || areaEvent.type !== 'area') {
            console.warn('⚠️ 無效的區域事件資料');
            return null;
        }
        
        // 檢查 seaDotManager 是否可用並等待初始化完成
        if (!window.seaDotManager) {
            console.warn('⚠️ SeaDotManager 未初始化，等待初始化完成...');
            // 返回 null，讓調用方知道需要稍後重試
            return null;
        }
        
        // 檢查 seaDotManager 是否有 seaDots 數據
        if (!window.seaDotManager.seaDots || window.seaDotManager.seaDots.size === 0) {
            console.warn('⚠️ SeaDotManager 的數據尚未加載完成，等待數據加載...');
            // 返回 null，讓調用方知道需要稍後重試
            return null;
        }
        
        // 從區域事件中獲取座標範圍
        const latRange = areaEvent.latRange;
        const lonRange = areaEvent.lonRange;
        
        if (!latRange || !lonRange) {
            console.warn('⚠️ 缺少座標範圍資訊，使用預設資料');
        }
        
        console.log(`📍 查詢範圍: 緯度 ${latRange}, 經度 ${lonRange}`);
        
        // 使用 SeaDotManager 查詢範圍內狀態為 "No AIS" 的監測點
        const noAISDots = window.seaDotManager.getDotsInRangeByStatus(latRange, lonRange, "No AIS");
        
        console.log(`🎯 找到 ${noAISDots.length} 個無 AIS 監測點:`, noAISDots);
        
        // 將監測點轉換為 RF 信號資料格式
        const rfSignalsWithoutAIS = noAISDots.map((dot, index) => {
            // 生成隨機頻率和信號強度（保持現有的變化性）
            const frequency = (Math.random() * (470 - 430) + 430).toFixed(1); // 430-470 MHz
            const strength = Math.floor(Math.random() * 50 + 30); // 30-80 dBm
            
            // 將座標轉換為度分秒格式字串
            const coordinatesString = `${dot.lat.toFixed(3)}°N, ${dot.lon.toFixed(3)}°E`;
            
            return {
                rfId: dot.rfId || `rf_${dot.id}_${index}`,
                coordinates: coordinatesString,
                frequency: `${frequency} MHz`,
                strength: `${strength} dBm`,
                aisStatus: '未開啟', // 明確設定AIS狀態
                detection_time: new Date().toLocaleString('zh-TW'),
                // 保留完整的原始監測點資訊
                sourceSeaDot: {
                    id: dot.id,
                    status: dot.status,
                    dotColor: getDotColor(dot),
                    area: dot.area,
                    lat: dot.lat,
                    lon: dot.lon,
                    display: {
                        dotColor: getDotColor(dot),
                        backgroundColor: (typeof getBackgroundColor === 'function' ? getBackgroundColor(dot) : (dot.backgroundColor || getDotColor(dot)))
                    }
                }
            };
        });
        
        // 如果沒有找到無 AIS 監測點，返回預設資料
        if (rfSignalsWithoutAIS.length === 0) {
            console.log('📝 範圍內無無 AIS 監測點，生成預設 RF 信號');
        }
        
        console.log(`✅ 成功生成 ${rfSignalsWithoutAIS.length} 個 RF 信號資料`);
        
        // 回傳結果物件
        return {
            areaId: areaEvent.id,
            areaName: areaEvent.aoiName,
            totalRFSignals: rfSignalsWithoutAIS.length,
            rfSignalsWithoutAIS: rfSignalsWithoutAIS,
            rfIdsWithoutAIS: rfSignalsWithoutAIS.map(signal => signal.rfId)
        };
        
    } catch (error) {
        console.error('❌ 查詢無 AIS RF 信號時發生錯誤:', error);
    }
}

// 事件卡選擇
function selectEvent(element, eventId) {
    // 如果該事件正在創建中，阻止選擇
    if (creatingEventIds.has(eventId)) {
        console.log(`事件 ${eventId} 正在創建中，無法選擇`);
        return;
    }

    // 移除其他卡片的 active 狀態
    document.querySelectorAll('.event-card').forEach(card => {
        card.classList.remove('active');
    });

    // 激活選中的卡片
    element.classList.add('active');
    currentEventId = eventId;

    // 更新詳情面板
    updateDetailsPanel(eventId);

    // 根據事件類型調整地圖視圖
    adjustMapViewForEvent(eventId);
}


// 用於存儲歷史軌跡動畫的全域變數
let historyTrackAnimation = null;
// 用於追蹤當前顯示歷史軌跡的船舶事件ID
let currentTrackingVesselId = null;

// 顯示地圖調整訊息的函數
function showMapAdjustmentMessage(message, duration = 1500) {
    // 建立訊息元素
    const messageElement = document.createElement('div');
    messageElement.textContent = message;
    messageElement.style.cssText = `
        position: absolute;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.8);
        color: #66e7ff;
        padding: 10px 20px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        z-index: 10000;
        border: 1px solid rgba(102, 231, 255, 0.3);
        backdrop-filter: blur(10px);
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        transition: opacity 0.3s ease;
        pointer-events: none;
    `;
    
    // 找到地圖容器並添加到其中
    const mapContainer = document.querySelector('.map-container');
    if (mapContainer) {
        // 確保地圖容器有相對定位
        if (getComputedStyle(mapContainer).position === 'static') {
            mapContainer.style.position = 'relative';
        }
        mapContainer.appendChild(messageElement);
    } else {
        // 如果找不到地圖容器，則使用 body
        document.body.appendChild(messageElement);
    }
    
    // 延遲移除
    setTimeout(() => {
        messageElement.style.opacity = '0';
        setTimeout(() => {
            if (messageElement.parentNode) {
                messageElement.parentNode.removeChild(messageElement);
            }
        }, 300);
    }, duration - 300);
}

/**
 * 聚焦地圖到指定事件的座標位置
 * @param {Object} eventData - 事件資料物件
 * @param {string} eventId - 事件ID
 * @param {string} eventType - 事件類型 ('vessel', 'rf', 'area')
 */
function focusMapToEventCoordinates(eventData, eventId, eventType) {
    if (!taiwanMap || !eventData || !eventData.coordinates) {
        console.warn(`⚠️ 無法聚焦地圖: 缺少必要參數`);
        return false;
    }

    // 事件類型配置
    const typeConfig = {
        'vessel': {
            displayName: '船舶',
            zoomLevel: 7,
            animationOptions: {
                animate: true,
                duration: 1.5,
                easeLinearity: 0.25
            }
        },
        'rf': {
            displayName: 'RF信號',
            zoomLevel: 7,
            animationOptions: {
                animate: true,
                duration: 1.5,
                easeLinearity: 0.25
            }
        },
    };

    const config = typeConfig[eventType];
    if (!config) {
        console.warn(`⚠️ 不支援的事件類型: ${eventType}`);
        return false;
    }

    try {
        const coords = parsePointCoordinates(eventData.coordinates);
        if (coords) {
            // 設定地圖視圖
            taiwanMap.setView([coords.lat, coords.lon], config.zoomLevel, config.animationOptions);
            
            // 顯示地圖調整訊息
            showMapAdjustmentMessage(`地圖已聚焦至${config.displayName}位置`);
            
            // 記錄日誌
            console.log(`🎯 地圖已調整至${config.displayName} ${eventId.toUpperCase()} 位置 (${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)})`);
            
            return true;
        } else {
            throw new Error('座標解析失敗');
        }
    } catch (error) {
        console.warn(`⚠️ 無法解析${eventType}事件 ${eventId} 的座標:`, error);
        return false;
    }
}

// 根據事件調整地圖視圖
function adjustMapViewForEvent(eventId) {
    console.log("adjusting map view for event:", eventId);
    if (!taiwanMap) return;
    
    // 清除先前的調查範圍顯示
    clearInvestigationRange();

    // 獲取當前事件資料
    const storedEvent = eventStorage.getEvent(eventId);
    if (!storedEvent) return;

    // 如果是船舶事件且是重複點擊同一個船舶，不清除現有軌跡
    if (storedEvent.type === 'vessel' && 
        currentTrackingVesselId === eventId && 
        historyTrackAnimation) {
        console.log(`🔄 重複點擊船舶事件 ${eventId}，保留現有歷史軌跡動畫`);
        // 使用統一的聚焦函數
        focusMapToEventCoordinates(storedEvent, eventId, 'vessel');
        return; // 提前返回，不繼續執行後面的清除邏輯
    }

    // 清除先前的歷史軌跡動畫（只在非重複點擊時清除）
    if (historyTrackAnimation) {
        if (historyTrackAnimation.timeout) {
            clearTimeout(historyTrackAnimation.timeout);
        }
        if (historyTrackAnimation.layers) {
            historyTrackAnimation.layers.forEach(layer => taiwanMap.removeLayer(layer));
        }
        historyTrackAnimation = null;
        currentTrackingVesselId = null;
        console.log('🛑 已停止並清除舊的歷史軌跡動畫。');
    }
    if (!storedEvent) return;
    
    if (storedEvent.type === 'area' && storedEvent.latRange && storedEvent.lonRange) {
        // 區域監控事件：先畫出調查範圍，再放大地圖
        
        // 恢復顯示信號點
        restoreHiddenSignalPoints();

        // 清除任何現有的歷史軌跡
        clearHistoryTrack();
        
        try {
            // 解析經緯度範圍
            const latRange = parseCoordinateRange(storedEvent.latRange);
            const lonRange = parseCoordinateRange(storedEvent.lonRange);
            
            if (latRange && lonRange) {
                
                // 短暫延遲後放大到該區域
                setTimeout(() => {
                    // 計算中心點
                    const centerLat = (latRange.min + latRange.max) / 2;
                    const centerLon = (lonRange.min + lonRange.max) / 2;
                    
                    // 計算適當的縮放等級（根據範圍大小）
                    const latSpan = latRange.max - latRange.min;
                    const lonSpan = lonRange.max - lonRange.min;
                    const maxSpan = Math.max(latSpan, lonSpan);
                    
                    let zoomLevel = 6 // 預設縮放等級
                    // if (maxSpan <= 0.5) zoomLevel = 11;      // 很小的區域
                    // else if (maxSpan <= 1.0) zoomLevel = 10; // 小區域
                    // else if (maxSpan <= 2.0) zoomLevel = 9;  // 中等區域
                    // else if (maxSpan <= 4.0) zoomLevel = 8;  // 大區域
                    
                    // 先繪製調查範圍矩形
                    drawInvestigationRange(latRange, lonRange, storedEvent.aoiName || eventId.toUpperCase());
                    
                    // 平滑地調整地圖視圖到目標區域
                    taiwanMap.setView([centerLat, centerLon], zoomLevel, {
                        animate: true,
                        duration: 1.5,
                        easeLinearity: 0.25
                    });
                    
                    console.log(`🎯 地圖已調整至 ${storedEvent.aoiName || eventId.toUpperCase()} 區域 (中心: ${centerLat.toFixed(3)}, ${centerLon.toFixed(3)}, 縮放: ${zoomLevel})`);
                    
                    // 顯示地圖調整訊息
                    showMapAdjustmentMessage(`地圖已聚焦至 ${storedEvent.aoiName || '監控區域'}`);
                }, 100);
                
            }
        } catch (error) {
            console.warn(`⚠️ 無法解析事件 ${eventId} 的座標範圍:`, error);
        }
    } else if (storedEvent.type === 'rf' && storedEvent.coordinates) {
        // 恢復顯示信號點
        restoreHiddenSignalPoints();

        // 清除任何現有的歷史軌跡
        clearHistoryTrack();

        // 使用統一的聚焦函數
        focusMapToEventCoordinates(storedEvent, eventId, 'rf');
    } else if (storedEvent.type === 'vessel') {
        // 船舶事件：找到 'Current' 點並定位，然後顯示軌跡
        
        // 顯示歷史軌跡
        displayHistoryTrack(storedEvent);

        // 清除非軌跡點的 SeaDots
        clearNonTrackPoints();

        // 找到 'Current' 點來定位地圖
        const currentPoint = storedEvent.trackPoints?.find(p => p.type === 'Current');
        
        let targetCoords;
        if (currentPoint) {
            targetCoords = { lat: currentPoint.lat, lon: currentPoint.lon };
            console.log(`🎯 找到 'Current' 點，將地圖定位至: (${targetCoords.lat.toFixed(3)}, ${targetCoords.lon.toFixed(3)})`);
        } else {
            // 如果找不到 'Current' 點，作為備用方案，使用 coordinates 屬性
            try {
                targetCoords = parsePointCoordinates(storedEvent.coordinates);
                console.warn(`⚠️ 在 ${eventId} 的軌跡中找不到 'Current' 點，使用備用座標定位`);
            } catch (error) {
                console.error(`❌ 無法為 ${eventId} 找到任何有效座標進行定位`);
                return;
            }
        }

        if (targetCoords) {
            // 為 Current 點創建臨時事件物件或使用原始事件資料
            const eventForFocus = currentPoint ? 
                { coordinates: `${targetCoords.lat.toFixed(3)}°N, ${targetCoords.lon.toFixed(3)}°E` } : 
                storedEvent;
            
            // 使用統一的聚焦函數
            focusMapToEventCoordinates(eventForFocus, eventId, 'vessel');
        }
    }
}

// 用於存儲調查範圍圖層的全域變數
let investigationRangeLayer = null;
// 用於存儲歷史軌跡圖層的全域變數
let currentHistoryLayers = [];

// 顯示船舶歷史軌跡（重構後）
function displayHistoryTrack(vesselEvent) {
    clearHistoryTrack(); // 清除舊的歷史軌跡

    if (!vesselEvent || !vesselEvent.trackPoints || !Array.isArray(vesselEvent.trackPoints)) {
        console.warn("⚠️ 無效的船舶事件或缺少軌跡點資訊");
        return;
    }

    console.log(`🗺️ 正在為 ${vesselEvent.id} 顯示 ${vesselEvent.trackPoints.length} 個歷史軌跡點`);
    currentTrackingVesselId = vesselEvent.id; // 在顯示軌跡時，設定當前追蹤的船舶ID

    const currentTime = new Date();

    // 由於現在只生成重要時間點，所有點都直接顯示
    const allPoints = [...vesselEvent.trackPoints].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // 首先繪製連線
    if (allPoints.length > 1) {
        const trackLine = L.polyline(
            allPoints.map(point => [point.lat, point.lon]),
            {
                color: '#3b82f6',
                weight: 2,
                opacity: 0.7,
                dashArray: '5, 10'
            }
        );
        trackLine.addTo(taiwanMap);
        currentHistoryLayers.push(trackLine);
    }

    // 然後顯示所有軌跡點標記
    vesselEvent.trackPoints.forEach(point => {
        const pointTime = new Date(point.timestamp);
        const isPast = pointTime < currentTime;

        let trackPointType, trackPointStatus;
        if (isPast) {
            trackPointType = 'History';
            trackPointStatus = point.hasTask ? 'Completed' : 'AIS';
        } else {
            trackPointType = 'Future';
            trackPointStatus = point.hasTask ? 'Scheduled' : 'AIS';
        }

        let marker;
        if (seaDotManager && typeof seaDotManager.createTrackSeaDotFromPoint === 'function') {
            marker = seaDotManager.createTrackSeaDotFromPoint(Object.assign({}, point, { pointId: point.pointId || getSafePointId(point) }));
        } else {
            marker = seaDotManager.createTrackSeaDot(
                point.lat,
                point.lon,
                getSafePointId(point),
                trackPointStatus,
                trackPointType,
                point,
                vesselEvent.id
            );
        }

        if (marker) {
            marker.addTo(taiwanMap);
            currentHistoryLayers.push(marker);
        }
    });

    console.log(`✅ 歷史軌跡顯示完成：${vesselEvent.trackPoints.length} 個重要時間點 + 軌跡連線`);
}

// 清除船舶歷史軌跡的輔助函數
function clearHistoryTrack() {
    if (currentHistoryLayers) {
        currentHistoryLayers.forEach(layer => taiwanMap.removeLayer(layer));
        currentHistoryLayers = [];
    }
    // 停止任何可能在運行的舊動畫
    if (historyTrackAnimation && historyTrackAnimation.timeout) {
        clearTimeout(historyTrackAnimation.timeout);
        historyTrackAnimation = null;
    }
    // 當清除軌跡時，也清除當前追蹤的船舶ID
    // currentTrackingVesselId = null;
}

// 跳轉到歷史軌跡點的函數
function jumpToHistoryPoint(hoursBack) {
    console.log(`🎯 用戶點擊了${hoursBack}小時前的按鈕`);
    
    // 添加按鈕點擊效果
    const clickedButton = event.target;
    clickedButton.classList.add('clicked');
    setTimeout(() => {
        clickedButton.classList.remove('clicked');
    }, 600);
    
    // 首先檢查是否有當前追蹤的船舶
    let targetVesselId = currentTrackingVesselId;
    console.log(`🚢 當前追蹤的船舶ID: ${targetVesselId}`);
    
    // 如果沒有當前追蹤的船舶，嘗試從正在運行的歷史軌跡動畫中獲取
    if (!targetVesselId && historyTrackAnimation && historyTrackAnimation.vesselId) {
        targetVesselId = historyTrackAnimation.vesselId;
        console.log(`🔄 使用正在顯示歷史軌跡的船舶: ${targetVesselId}`);
    }
    
    if (!targetVesselId) {
        console.warn('⚠️ 目前沒有選中的船舶事件，無法跳轉到歷史軌跡點');
        // 顯示用戶友好的提示
        showUserMessage('請先點擊船舶事件卡片來選擇一個船舶，然後再使用歷史軌跡檢視', 'warning');
        return;
    }
    
    // 獲取當前船舶事件
    const vesselEvent = eventStorage.getEvent(targetVesselId);
    if (!vesselEvent || !vesselEvent.trackPoints || vesselEvent.trackPoints.length === 0) {
        console.warn('⚠️ 船舶事件沒有歷史軌跡點資料');
        showUserMessage('該船舶事件沒有可用的歷史軌跡資料', 'warning');
        return;
    }
    
    console.log(`🎯 準備跳轉到船舶 ${targetVesselId} 的前${hoursBack}小時位置...`);
    
    // 獲取當前船舶位置
    const currentPosition = getCurrentVesselPosition(vesselEvent);
    if (!currentPosition) {
        console.warn('⚠️ 無法獲取當前船舶位置');
        showUserMessage('無法獲取船舶當前位置', 'error');
        return;
    }
    
    // 根據指定的小時數找到對應的歷史軌跡點
    const targetPoint = findHistoryPointByHours(vesselEvent.trackPoints, hoursBack);
    if (!targetPoint) {
        console.warn(`⚠️ 找不到前${hoursBack}小時的歷史軌跡點`);
        showUserMessage(`找不到前${hoursBack}小時的歷史軌跡點`, 'warning');
        return;
    }
    
    console.log(`📍 找到前${hoursBack}小時的位置: (${targetPoint.lat.toFixed(4)}, ${targetPoint.lon.toFixed(4)})`);
    
    // 自動定位到該點
    focusOnHistoryPoint(targetPoint, hoursBack);
    
    // 顯示成功提示
    // showUserMessage(`已定位到前${hoursBack}小時的位置`, 'success');
}

// 獲取當前船舶位置
function getCurrentVesselPosition(vesselEvent) {
    try {
        if (vesselEvent.coordinates) {
            const coords = parsePointCoordinates(vesselEvent.coordinates);
            return coords;
        }
        return null;
    } catch (error) {
        console.warn('⚠️ 解析船舶座標時發生錯誤:', error);
        return null;
    }
}

// 根據小時數找到對應的歷史軌跡點
function findHistoryPointByHours(trackPoints, hoursBack) {
    const totalPoints = trackPoints.length;
    if (totalPoints === 0) return null;
    
    // 重要時間點數組，與生成軌跡點時使用的相同
    const importantHours = [120, 96, 72, 48, 24, 12, 6, 3, 0];
    
    // 找到最接近的時間點索引
    let closestIndex = -1;
    let minDiff = Infinity;
    
    importantHours.forEach((hours, index) => {
        const diff = Math.abs(hours - hoursBack);
        if (diff < minDiff) {
            minDiff = diff;
            closestIndex = index;
        }
    });
    
    // 確保索引在有效範圍內
    if (closestIndex >= 0 && closestIndex < totalPoints) {
        const selectedPoint = trackPoints[closestIndex];
        const actualHours = importantHours[closestIndex];
        
        console.log(`📊 軌跡點選擇詳情:
            - 總點數: ${totalPoints}
            - 要求時間: ${hoursBack}小時前
            - 實際選中: ${actualHours}小時前 (索引: ${closestIndex})
            - 選中點座標: (${selectedPoint.lat.toFixed(4)}, ${selectedPoint.lon.toFixed(4)})`);
        
        return selectedPoint;
    }
    
    // 如果沒有找到合適的索引，返回第一個點
    console.warn(`⚠️ 無法找到 ${hoursBack} 小時前的軌跡點，返回第一個可用點`);
    return trackPoints[0];
}

// 聚焦到歷史軌跡點
function focusOnHistoryPoint(targetPoint, hoursBack) {
    if (!taiwanMap) {
        console.warn('⚠️ 地圖未初始化');
        return;
    }
    
    // 保持當前縮放等級，不進行自動放大
    const currentZoom = taiwanMap.getZoom();
    
    console.log(`🔍 準備移動地圖到: (${targetPoint.lat.toFixed(6)}, ${targetPoint.lon.toFixed(6)}), 保持縮放: ${currentZoom}`);
    
    // 強制刷新地圖容器尺寸（防止容器尺寸問題）
    setTimeout(() => {
        taiwanMap.invalidateSize();
    }, 10);
    
    // 延遲後移動地圖（防止其他操作干擾）
    setTimeout(() => {
        taiwanMap.setView([targetPoint.lat, targetPoint.lon], currentZoom, {
            animate: true,
            duration: 1.5,
            easeLinearity: 0.25
        });
    }, 20);
    
    // 在目標點顯示一個臨時標記
    showTemporaryMarker(targetPoint, hoursBack);
    
    // 突出顯示該時間段的軌跡
    highlightHistorySegment(hoursBack);
}

// 突出顯示歷史軌跡段
function highlightHistorySegment(hoursBack) {
    if (!currentTrackingVesselId || !historyTrackAnimation || !historyTrackAnimation.layers) {
        return;
    }
    
    // 獲取船舶事件和軌跡點
    const vesselEvent = eventStorage.getEvent(currentTrackingVesselId);
    if (!vesselEvent || !vesselEvent.trackPoints) {
        return;
    }
    
    const trackPoints = vesselEvent.trackPoints;
    const totalPoints = trackPoints.length;
    
    // 計算要突出顯示的軌跡段範圍
    const totalHours = 2;
    const hoursPerPoint = totalHours / totalPoints;
    const pointsBack = Math.round(hoursBack / hoursPerPoint);
    const targetIndex = Math.max(0, totalPoints - 1 - pointsBack);
    
    // 突出顯示該段軌跡的標記
    historyTrackAnimation.layers.forEach((layer, index) => {
        if (layer.setStyle) { // 是線段
            if (index <= targetIndex * 2 + 1) { // 線段索引計算
                layer.setStyle({
                    color: '#ff6b6b',
                    weight: 3,
                    opacity: 0.9
                });
            } else {
                layer.setStyle({
                    color: 'grey',
                    weight: 1,
                    opacity: 0.5
                });
            }
        }
    });
    
    // 2秒後恢復原來的樣式
    setTimeout(() => {
        if (historyTrackAnimation && historyTrackAnimation.layers) {
            historyTrackAnimation.layers.forEach(layer => {
                if (layer.setStyle) {
                    layer.setStyle({
                        color: 'grey',
                        weight: 1,
                        opacity: 1,
                        dashArray: '5, 5'
                    });
                }
            });
        }
    }, 2000);
}

// 顯示臨時標記
function showTemporaryMarker(point, hoursBack) {
    // 創建一個臨時標記來標示目標點
    const tempMarker = L.marker([point.lat, point.lon], {
        icon: L.divIcon({
            className: 'temp-history-marker',
            html: `<div style="
                background: #ff6b6b;
                border: 3px solid white;
                border-radius: 50%;
                width: 24px;
                height: 24px;
                box-shadow: 0 0 10px rgba(255, 107, 107, 0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 10px;
                font-weight: bold;
                color: white;
            ">${hoursBack}h</div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 22]  // 修改為與三角形軌跡點相同的錨點位置
        })
    }).addTo(taiwanMap);
    
    // 添加彈出提示
    tempMarker.bindPopup(`
        <div style="text-align: center;">
            <strong>${hoursBack}小時前</strong><br>
            <span style="font-size: 12px; color: #666;">
                座標: ${point.lat.toFixed(4)}°N, ${point.lon.toFixed(4)}°E
            </span>
        </div>
    `, {
        offset: [0, -10]  // 將popup往上移15像素
    }).openPopup();
    
    // 3秒後自動移除標記
    setTimeout(() => {
        taiwanMap.removeLayer(tempMarker);
        console.log(`🗑️ 已移除前${hoursBack}小時位置的臨時標記`);
    }, 3000);
}

// 顯示用戶訊息的函數
function showUserMessage(message, type = 'info') {
    // 創建訊息元素
    const messageDiv = document.createElement('div');
    messageDiv.className = `user-message user-message-${type}`;
    messageDiv.textContent = message;
    
    // 設定樣式
    messageDiv.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : type === 'success' ? '#10b981' : '#3b82f6'};
        color: white;
        padding: 12px 24px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        animation: slideDown 0.3s ease-out;
    `;
    
    // 添加到頁面
    document.body.appendChild(messageDiv);
    
    // 3秒後自動移除
    setTimeout(() => {
        if (messageDiv.parentNode) {
            messageDiv.style.animation = 'slideUp 0.3s ease-in';
            setTimeout(() => {
                document.body.removeChild(messageDiv);
            }, 300);
        }
    }, 3000);
}

// 繪製調查範圍矩形
function drawInvestigationRange(latRange, lonRange, areaName) {
    if (!taiwanMap) return;
    
    // 清除調查範圍顯示
    clearInvestigationRange();
    
    // 定義矩形邊界
    const bounds = [
        [latRange.min, lonRange.min], // 西南角
        [latRange.max, lonRange.max]  // 東北角
    ];
    
    // 創建調查範圍矩形
    const rectangle = L.rectangle(bounds, {
        color: '#9e9e0fff',        // 邊框顏色
        fillColor: '#9e9e0fff',    // 填充顏色
        fillOpacity: 0.2,        // 填充透明度
        weight: 2,               // 邊框粗細
        opacity: 0.8,            // 邊框透明度
        dashArray: '5, 10'       // 虛線樣式
    });
    
    // 加入到地圖並設置彈出資訊
    rectangle.addTo(taiwanMap)
    
    // 儲存到全域變數以便後續清除
    investigationRangeLayer = rectangle;
    
    console.log(`📍 已繪製調查範圍：${areaName} (${latRange.min.toFixed(3)}-${latRange.max.toFixed(3)}°N, ${lonRange.min.toFixed(3)}-${lonRange.max.toFixed(3)}°E)`);
}

// 清除調查範圍顯示
function clearInvestigationRange() {
    if (investigationRangeLayer && taiwanMap) {
        taiwanMap.removeLayer(investigationRangeLayer);
        investigationRangeLayer = null;
        console.log('🗑️ 已清除先前的調查範圍顯示');
    }
}

// 將純數字格式的座標範圍轉換為標準格式
function formatCoordinateRange(rangeStr, isLatitude) {
    if (!rangeStr) return null;
    
    // 如果已經包含度數符號，直接返回
    if (rangeStr.includes('°')) {
        return rangeStr;
    }
    
    // 解析純數字格式 "24.2 - 24.8"
    const parts = rangeStr.trim().split('-');
    if (parts.length === 2) {
        const min = parseFloat(parts[0].trim());
        const max = parseFloat(parts[1].trim());
        
        if (!isNaN(min) && !isNaN(max)) {
            const unit = isLatitude ? 'N' : 'E';
            return `${min.toFixed(1)}°${unit} - ${max.toFixed(1)}°${unit}`;
        }
    }
    
    return null;
}

// 解析座標範圍字串 (支持兩種格式: "24.2°N - 24.8°N" 或 "24.2 - 24.8")
function parseCoordinateRange(rangeStr) {
    try {
        // 如果包含度數符號，使用舊格式解析
        if (rangeStr.includes('°')) {
            // 移除度數符號和方位字母，提取數字部分
            const cleanRange = rangeStr.replace(/[°NSEW\s]/g, '');
            const parts = cleanRange.split('-');
            
            if (parts.length === 2) {
                const min = parseFloat(parts[0]);
                const max = parseFloat(parts[1]);
                
                if (!isNaN(min) && !isNaN(max)) {
                    return { min, max };
                }
            }
        } else {
            // 新格式：純數字格式 "24.2 - 24.8"
            const parts = rangeStr.trim().split('-');
            
            if (parts.length === 2) {
                const min = parseFloat(parts[0].trim());
                const max = parseFloat(parts[1].trim());
                
                if (!isNaN(min) && !isNaN(max)) {
                    return { min, max };
                }
            }
        }
        return null;
    } catch (error) {
        console.warn('座標範圍解析失敗:', rangeStr, error);
        return null;
    }
}

// 解析單點座標字串 (例如: "24.456°N, 120.789°E" 或 "24.123°N, 121.045°E")
function parsePointCoordinates(coordStr) {
    try {
        // 移除度數符號和方位字母
        const cleanCoord = coordStr.replace(/[°NSEW\s]/g, '');
        const parts = cleanCoord.split(',');
        
        if (parts.length === 2) {
            const lat = parseFloat(parts[0]);
            const lon = parseFloat(parts[1]);
            
            if (!isNaN(lat) && !isNaN(lon)) {
                return { lat, lon };
            }
        }
        return null;
    } catch (error) {
        console.warn('單點座標解析失敗:', coordStr, error);
        return null;
    }
}

// 更新詳情面板內容
function updateDetailsPanel(eventId) {
    const detailsTitle = document.getElementById('detailsTitle');
    const detailsSubtitle = document.getElementById('detailsSubtitle');
    const detailsContent = document.getElementById('detailsContent');

    // 從儲存中取得事件資料
    const storedEvent = eventStorage.getEvent(eventId);

    let data;
    if (storedEvent) {
        // 使用儲存的資料生成詳情
        const eventIdUpper = eventId.toUpperCase();
        
        switch (storedEvent.type) {
            case 'area':
                data = {
                    title: `${eventIdUpper} 事件詳情`,
                    subtitle: `區域監控事件`,
                    content: getAreaEventDetailsFromStorage(storedEvent)
                };
                break;
            case 'rf':
                data = {
                    title: `${eventIdUpper} 事件詳情`,
                    subtitle: `RF 監控事件`,
                    content: getRFEventDetailsFromStorage(storedEvent)
                };
                break;
            case 'vessel':
                data = {
                    title: `${eventIdUpper} 事件詳情`,
                    subtitle: `船舶監控事件${storedEvent.status === 'completed' ? ' | 已結束' : ''}`,
                    content: getVesselEventDetailsFromStorage(storedEvent)
                };
                break;
        }
    } 

    detailsTitle.textContent = data.title;
    detailsSubtitle.textContent = data.subtitle;
    detailsContent.innerHTML = data.content;
}

// 從儲存資料生成區域監控事件詳情
function getAreaEventDetailsFromStorage(eventData) {
    console.log('getAreaEventDetailsFromStorage called for:', eventData.id);

    // 檢查是否需要動態生成 RF 候選資訊
    if (!eventData.rfCandidates && !eventData.rfCandidatesData) {
        console.log(`🔄 為事件 ${eventData.id} 統一使用 getRFSignalsWithoutAIS 動態生成 RF 候選清單...`);
        
        // 創建一個帶有重試機制的函數來動態建立未開啟AIS的RF信號點
        const attemptGetRFSignals = (retryCount = 0, maxRetries = 5) => {
            const rfSignalsInfo = getRFSignalsWithoutAIS(eventData);
            console.log('getRFSignalsWithoutAIS result:', rfSignalsInfo);
            
            if (rfSignalsInfo && rfSignalsInfo.rfSignalsWithoutAIS) {
                // 成功獲取數據，建立 rfCandidates 清單
                eventData.rfCandidates = rfSignalsInfo.rfIdsWithoutAIS;
                
                // 建立 rfCandidatesData 詳細資料
                eventData.rfCandidatesData = rfSignalsInfo.rfSignalsWithoutAIS.map((signal, index) => {
                    return {
                        rfId: signal.rfId,
                        frequency: signal.frequency,
                        strength: signal.strength,
                        coordinates: signal.coordinates,
                        index: index,
                        aisStatus: signal.aisStatus
                    };
                });
                
                // 更新儲存的事件資料
                eventStorage.updateEvent(eventData.id, { 
                    rfCandidates: eventData.rfCandidates,
                    rfCandidatesData: eventData.rfCandidatesData 
                });
                
                console.log(`✅ 已為事件 ${eventData.id} 透過 getRFSignalsWithoutAIS 動態生成並儲存 RF 候選資訊:`, {
                    rfCandidates: eventData.rfCandidates,
                    rfCandidatesData: eventData.rfCandidatesData
                });
                
                // 重新更新詳情面板以顯示新數據
                if (eventData.id === currentEventId) {
                    setTimeout(() => updateDetailsPanel(eventData.id), 100);
                }
            } else if (retryCount < maxRetries) {
                // 如果數據尚未準備好且還有重試次數，延遲重試
                console.log(`🔄 SeaDot 數據尚未準備完成，${500 * (retryCount + 1)}ms 後重試 (${retryCount + 1}/${maxRetries})`);
                setTimeout(() => attemptGetRFSignals(retryCount + 1, maxRetries), 500 * (retryCount + 1));
            } else {
                console.warn(`⚠️ getRFSignalsWithoutAIS 重試 ${maxRetries} 次後仍無法為事件 ${eventData.id} 生成RF信號點資訊`);
            }
        };
        
        // 開始嘗試獲取 RF 信號數據
        attemptGetRFSignals();
    }

    // 使用已儲存的數據生成 HTML
    const rfCandidatesHtml = eventData.rfCandidatesData && eventData.rfCandidatesData.length > 0 
        ? eventData.rfCandidatesData
            // 排序：優先緯度由大到小，再由經度由小到大
            .sort((a, b) => {
                // 解析座標字串，提取緯度和經度數值
                const parseCoords = (coordStr) => {
                    // 座標格式：例如 "24.123°N, 121.045°E"
                    const match = coordStr.match(/(\d+\.\d+)°N,\s*(\d+\.\d+)°E/);
                    if (match) {
                        return { lat: parseFloat(match[1]), lon: parseFloat(match[2]) };
                    }
                    return { lat: 0, lon: 0 }; // 預設值
                };
                
                const coordsA = parseCoords(a.coordinates);
                const coordsB = parseCoords(b.coordinates);
                
                // 先比較緯度（由大到小）
                if (coordsA.lat !== coordsB.lat) {
                    return coordsB.lat - coordsA.lat;
                }
                
                // 緯度相同時，再比較經度（由小到大）
                return coordsA.lon - coordsB.lon;
            })
            .map((candidateData) => {
            return `
                <div class="evidence-item">
                    <div class="evidence-title">${candidateData.rfId}</div>
                    <div class="evidence-desc">
                        📡 頻率: ${candidateData.frequency} | 強度: ${candidateData.strength}<br>
                        📍 座標: ${candidateData.coordinates}<br>
                    </div>
                    <div style="margin-top: 8px; display: flex; justify-content: flex-end;">
                        <button class="create-rf-btn" onclick="createRFEventfromArea('${candidateData.rfId}')" 
                                style="background: #f59e0b; color: white; border: none; padding: 6px 12px; border-radius: 4px; font-size: 10px; font-weight: bold; cursor: pointer; transition: all 0.3s ease;">
                            建立RF監控事件
                        </button>
                    </div>
                </div>
            `;
        }).join('')
        : '<div style="color: #b8c5d1; text-align: center; padding: 20px;">暫無異常候選</div>';

    return `
        <div class="summary-section">
            <div class="section-title">事件簡介</div>
            <div style="font-size: 13px; line-height: 1.5; color: #b8c5d1;">
                <strong>監控區域：</strong>${eventData.aoiName || '未設定'}<br>
                <strong>緯度範圍：</strong>${eventData.latRange || '未設定'}<br>
                <strong>經度範圍：</strong>${eventData.lonRange || '未設定'}<br>
                <strong>建立時間：</strong>${eventData.createTime}<br>
                <strong>監控時間：</strong>${eventData.monitorTimeRange}<br>
            </div>
        </div>

        <div class="evidence-section">
            <div class="section-title">📊 RF 信號異常列表</div>
            ${rfCandidatesHtml}
        </div>

        <div class="action-section">
            <div class="section-title">⚡ 可用操作</div>
            <div class="action-grid">
                <div class="action-btn" onclick="refreshAOI()">🔄<br>重新掃描</div>
                <div class="action-btn" onclick="expandAOI()">📏<br>擴大 AOI</div>
                <div class="action-btn" onclick="exportData()">📊<br>匯出資料</div>
                <div class="action-btn" onclick="closeEvent()">✅<br>結束事件</div>
            </div>
        </div>
    `;
}

// 從儲存資料生成 RF 監控事件詳情
function getRFEventDetailsFromStorage(eventData) {
    // 使用AIS狀態一致性管理函數確保狀態正確
    eventData = ensureAISStatusConsistency(eventData);
    
    // 生成船隻信息內容
    let shipInfoSection = '';
    if (eventData.aisStatus === '已開啟') {
        // AIS開啟 - 顯示該船的簡單信息
        const shipInfo = generateShipInfo(eventData);
        eventData.shipInfo = shipInfo; // 儲存生成的船隻資訊
        shipInfoSection = `
        <div class="evidence-section">
            <div class="section-title">🚢 船隻資訊</div>
            <div class="ship-info-card ais-enabled">
                <div class="ship-header">
                    <span class="ship-type">${shipInfo.type}</span>
                    <span class="ship-status status-ais">AIS已開啟</span>
                </div>
                <div class="ship-image-container">
                    <img src="${shipInfo.image}" alt="${shipInfo.type}" class="ship-image" />
                </div>
                <div class="ship-details">
                    <div class="detail-row"><span>MMSI:</span><span>${shipInfo.mmsi}</span></div>
                    <div class="detail-row"><span>船長:</span><span>${shipInfo.length}公尺</span></div>
                    <div class="detail-row"><span>船寬:</span><span>${shipInfo.beam}公尺</span></div>
                    <div class="detail-row"><span>航速:</span><span>${shipInfo.speed}節</span></div>
                    <div class="detail-row"><span>航向:</span><span>${shipInfo.course}°</span></div>
                </div>
            </div>
        </div>`;
    } else {
        // AIS未開啟 - 顯示可疑船隻候選列表
        const candidates = generateSuspiciousCandidates(eventData);
        let candidateHtml = '';
        
        candidates.forEach(candidate => {
            candidateHtml += `
            <div class="candidate-item">
                <div class="candidate-header">
                    <span class="candidate-name">${candidate.name}</span>
                    <span class="probability">${(candidate.probability * 100).toFixed(0)}%</span>
                </div>
                <div class="candidate-details">
                    <div>類型: ${candidate.type} | 長度: ${candidate.length}m</div>
                    <div>最後出現: ${candidate.lastSeen}</div>
                </div>
                <button class="investigate-btn-small" onclick="createVesselEventFromRF()")">
                    建立船舶調查
                </button>
            </div>`;
        });
        
        shipInfoSection = `
        <div class="evidence-section">
            <div class="section-title">🚢 船隻資訊</div>
            <div class="ship-info-card no-ais">
                <div class="ship-header">
                    <span class="ship-name">未知RF信號</span>
                    <span class="ship-status status-no-ais">無AIS</span>
                </div>
                <div class="candidate-list">
                    <h4 style="margin: 10px 0; color: #333;">可疑船隻候選列表</h4>
                    ${candidateHtml}
                </div>
            </div>
        </div>`;
    }
    
    return `
        <div class="summary-section">
            <div class="section-title">事件簡介</div>
            <div style="font-size: 13px; line-height: 1.5; color: #b8c5d1;">
                <strong>RF 信號 ID：</strong>${eventData.rfId || '未知'}<br>
                <strong>座標：</strong>${eventData.coordinates || '定位中'}<br>
                <strong>AIS狀態：</strong><span style="color: ${eventData.aisStatus === '已開啟' ? '#10b981' : '#ef4444'};">${eventData.aisStatus || '未知'}</span><br>
                <strong>建立時間：</strong>${eventData.createTime}<br>
                ${eventData.notes ? `<strong>備註：</strong>${eventData.notes}<br>` : ''}
            </div>
        </div>
    
        <div class="evidence-section">
            <div class="section-title">📊 RF 監控資訊</div>
            
            <div class="evidence-item">
                <div class="evidence-title">信號特徵</div>
                <div class="evidence-desc">
                    📡 頻率: ${eventData.frequency || '檢測中'}<br>
                    📊 強度: ${eventData.strength || '檢測中'}<br>
                    🔍 調變: GMSK<br>
                </div>
            </div>
            
            <!-- <div class="evidence-item">
                <div class="evidence-title">位置資訊</div>
                <div class="evidence-desc">
                    📍 座標: ${eventData.coordinates || '定位中'}<br>
                    🗺️ 區域: 台海海域<br>
                    📏 精度: ±500m<br>
                    🧭 移動方向: 未檢測到明顯移動
                </div>
            </div> -->
        </div>

        ${shipInfoSection}
    `;            
}

// 生成船隻資訊（AIS開啟時使用）
function generateShipInfo(eventData) {
    const shipTypes = ['貨輪', '漁船'];
    const shipNamePrefixes = ['MV', 'SS', 'MT', 'FV'];
    const shipNameSuffixes = ['Navigator', 'Explorer', 'Pioneer', 'Guardian', 'Voyager', 'Mariner', 'Ocean Star', 'Sea Wind'];
    const destinations = ['高雄港', '基隆港', '台中港', '花蓮港', '台南港', '馬公港', '金門港'];
    
    // 根據eventData生成一致的船隻資訊
    const rfId = eventData.rfId || 'SIG-DEFAULT';
    const seed = rfId.split('-')[1] || '000';
    const numSeed = parseInt(seed.replace(/[^0-9]/g, ''), 16) || 123;
    
    const selectedShipType = shipTypes[numSeed % shipTypes.length];
    
    // 根據船舶類型獲取對應的圖片路徑
    const getShipImage = (shipType) => {
        return `images/${shipType}.jpg`;
    };
    
    return {
        name: `${shipNamePrefixes[numSeed % shipNamePrefixes.length]} ${seed} ${shipNameSuffixes[numSeed % shipNameSuffixes.length]}`,
        mmsi: `416${(numSeed % 1000000).toString().padStart(6, '0')}`,
        type: selectedShipType,
        image: getShipImage(selectedShipType),
        length: 80 + (numSeed % 270),
        beam: 12 + (numSeed % 35),
        destination: destinations[numSeed % destinations.length],
        speed: 8 + (numSeed % 15),
        course: numSeed % 360
    };
}

// 生成可疑船隻候選列表（AIS未開啟時使用）  
function generateSuspiciousCandidates(eventData) {
    const vesselTypes = ['漁船', '貨船', '客船', '油輪', '軍艦', '研究船', '遊艇', '拖船'];
    const vesselNames = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
    
    const rfId = eventData.rfId || 'SIG-DEFAULT';
    const seed = rfId.split('-')[1] || '000';
    const numSeed = parseInt(seed.replace(/[^0-9]/g, ''), 16) || 123;
    
    const numCandidates = 2 + (numSeed % 4); // 2-5個候選
    const candidates = [];
    
    for (let i = 0; i < numCandidates; i++) {
        const candidateSeed = numSeed + i * 17; // 為每個候選生成不同種子
        const probability = 0.30 + (candidateSeed % 55) / 100; // 0.30-0.85
        const hoursAgo = 1 + (candidateSeed % 12); // 1-12小時前
        const vesselType = vesselTypes[candidateSeed % vesselTypes.length];
        const nameSuffix = vesselNames[candidateSeed % vesselNames.length];
        const length = 50 + (candidateSeed % 250); // 50-300米
        
        const lastSeenDate = new Date();
        lastSeenDate.setHours(lastSeenDate.getHours() - hoursAgo);
        
        candidates.push({
            id: `CAND_${rfId}_${i+1}`,
            name: `未知${vesselType} ${nameSuffix}`,
            probability: probability,
            lastSeen: lastSeenDate.toLocaleString('zh-TW', { 
                month: '2-digit', 
                day: '2-digit', 
                hour: '2-digit', 
                minute: '2-digit' 
            }),
            type: vesselType,
            length: length
        });
    }
    
    // 按機率排序
    return candidates.sort((a, b) => b.probability - a.probability);
}

// deprecated
// 顯示船舶詳細資訊 - 切換到對應的船舶監控事件卡
function showShipDetails(shipId) {
    console.log(`📋 切換到船舶詳情: ${shipId}`);
    
    // 查找由當前RF事件創建的船舶監控事件
    const vesselEventId = findVesselEventBySourceRF(currentEventId);
    console.log(`🔍 查找到的船舶事件ID: ${vesselEventId}`);
    
    if (vesselEventId) {
        // 直接通過事件ID查找對應的事件卡
        const eventCards = document.querySelectorAll('.event-card');
        let vesselCard = null;
        
        // 更可靠的查找方式：檢查事件卡內的事件ID文本
        eventCards.forEach(card => {
            const eventIdElement = card.querySelector('.event-id');
            if (eventIdElement && eventIdElement.textContent.toLowerCase() === vesselEventId) {
                vesselCard = card;
                console.log(`🎯 找到匹配的船舶事件卡: ${vesselEventId}`);
            }
        });
        
        if (vesselCard) {
            // 直接調用selectEvent來切換事件
            selectEventDirectly(vesselCard, vesselEventId);
            console.log(`✅ 已切換到船舶監控事件詳情: ${vesselEventId}`);
        } else {
            console.warn(`未找到對應的船舶監控事件卡: ${vesselEventId}`);
            // 作為備用，嘗試原來的方法
            eventCards.forEach(card => {
                if (card.onclick && card.onclick.toString().includes(vesselEventId)) {
                    selectEventDirectly(card, vesselEventId);
                    console.log(`✅ 通過備用方法切換到船舶監控事件: ${vesselEventId}`);
                }
            });
        }
    } else {
        console.warn('未找到對應的船舶監控事件');
    }
}

// deprecated
// 顯示候選船隻詳細資訊 - 切換到對應的船舶監控事件卡
function showCandidateDetails(candidateId) {
    console.log(`📋 切換到候選船隻詳情: ${candidateId}`);
    
    // 同樣切換到船舶監控事件卡
    showShipDetails(candidateId);
}

// 根據來源RF事件查找對應的船舶監控事件
function findVesselEventBySourceRF(rfEventId) {
    console.log(`🔍 查找RF事件 ${rfEventId} 對應的船舶事件`);
    const allEvents = eventStorage.getAllEvents();
    console.log(`📋 總共有 ${allEvents.length} 個事件`);
    
    for (const eventData of allEvents) {
        console.log(`📋 檢查事件: ${eventData.id}, 類型: ${eventData.type}, sourceRFEvent: ${eventData.sourceRFEvent}`);
        if (eventData.type === 'vessel' && eventData.sourceRFEvent === rfEventId) {
            console.log(`✅ 找到匹配的船舶事件: ${eventData.id}`);
            return eventData.id.toLowerCase();
        }
    }
    console.log(`❌ 未找到RF事件 ${rfEventId} 對應的船舶事件`);
    return null;
}

// 直接選擇事件（不觸發RF自動創建船舶事件的邏輯）
function selectEventDirectly(element, eventId) {
    // 移除其他卡片的 active 狀態
    document.querySelectorAll('.event-card').forEach(card => {
        card.classList.remove('active');
    });
    
    // 激活選中的卡片
    element.classList.add('active');
    currentEventId = eventId;
    
    // 更新詳情面板（但不執行RF自動創建邏輯）
    updateDetailsPanel(eventId);

    // 根據事件類型調整地圖視圖
    adjustMapViewForEvent(eventId);
    
    console.log(`✅ 已直接切換到事件: ${eventId}`);
}

// 從儲存資料生成船舶監控事件詳情
function getVesselEventDetailsFromStorage(eventData) {
    // 隨機生成AIS狀態（如果尚未設置）
    if (!eventData.aisStatus) {
        const aisStates = ['已開啟', '未開啟'];
        eventData.aisStatus = aisStates[Math.floor(Math.random() * aisStates.length)];
        
        // 將AIS狀態儲存回事件資料中
        if (eventData.id && eventStorage) {
            eventStorage.updateEvent(eventData.id, { aisStatus: eventData.aisStatus });
        }
        
        console.log(`🚢 為事件 ${eventData.id || '船舶事件'} 隨機生成AIS狀態: ${eventData.aisStatus}`);
    }
    
    const riskScore = eventData.riskScore || 0;
    const riskColor = riskScore >= 70 ? '#ef4444' : riskScore >= 40 ? '#f59e0b' : '#10b981';
    const riskLevel = riskScore >= 70 ? '高風險' : riskScore >= 40 ? '中風險' : '低風險';
    const isCompleted = eventData.status === 'completed';
                
    let actionSection = '';
    
    if (!isCompleted) {
        // 生成決策建議內容
        const recommendations = getVesselDecisionRecommendation(riskScore, eventData);
        
        actionSection = `
            <div class="action-section">
                <!-- 1. 行動選項標題 -->
                <div class="section-title large" style="color: #d89f0eff;">⚡ 行動選項</div>
                
                <!-- 2. 決策建議 (移動到行動選項標題之下) -->
                <div class="section-title collapsible-header" onclick="toggleDecisionRecommendation()">
                    💡 決策建議 
                    <span class="collapse-icon" id="decision-collapse-icon">▼</span>
                </div>
                <div class="decision-recommendation collapsed" id="decision-recommendation-content">
                    <div class="recommendation-content">
                        <div class="recommendation-title">建議行動：${recommendations.primaryAction}</div>
                        <div class="recommendation-analysis">
                            <strong>分析：</strong>${recommendations.analysis}
                        </div>
                        <div class="recommendation-evidence">
                            <strong>主要證據：</strong>${recommendations.evidence}
                        </div>
                        <div class="recommendation-priority" style="color: ${recommendations.priorityColor};">
                            優先級：${recommendations.priority}
                        </div>
                    </div>
                </div>
                
                <!-- 3. 四個行動選項按鈕 (可多選) -->
                <div class="action-grid">
                    <div class="action-btn" onclick="selectAction('track', this)">🎯<br>持續追蹤</div>
                    <div class="action-btn" onclick="selectAction('satellite', this)">🛰️<br>衛星重拍</div>
                    <div class="action-btn" onclick="selectAction('notify', this)">📞<br>通知單位</div>
                    <div class="action-btn" onclick="selectAction('uav', this)">🚁<br>派遣載具</div>
                </div>

                <!-- 4. 時間排程選擇 -->
                <div class="action-section">
                        <div class="section-title large" style="color: #d89f0eff;">⏰ 執行時間</div>
                    <div class="time-selection">
                        <div class="time-option-group">
                            <label class="time-option">
                                <input type="radio" name="executeTime" value="immediate" checked onchange="toggleTimeSelector()">
                                <span class="time-option-text">立即執行</span>
                            </label>
                            <label class="time-option">
                                <input type="radio" name="executeTime" value="scheduled" onchange="toggleTimeSelector()">
                                <span class="time-option-text">排程執行</span>
                            </label>
                        </div>

                        <div class="scheduled-time-picker" id="scheduledTimePicker" style="display: none;">
                            <div class="time-input-group">
                                <label for="scheduledDateTime">預定執行時間：</label>
                                <input type="datetime-local" id="scheduledDateTime" class="time-input" min="${new Date(Date.now() + 5 * 60000).toISOString().slice(0, 16)}">
                            </div>
                            <div class="time-note">
                                <small>📝 注意：排程時間必須在未來至少 5 分鐘</small>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    } else {
        actionSection = `
            <div class="action-section">
                <div class="section-title">✅ 事件已結束</div>
                <div style="color: #10b981; font-size: 13px; text-align: center; padding: 15px;">
                    調查結果: 確認為正常漁船作業<br>
                    結案時間: ${eventData.completedTime || '未記錄'}
                </div>
            </div>
        `;
    }
    
    return `
        <div class="summary-section">
            <div class="section-title">事件簡介</div>
            <div style="font-size: 13px; line-height: 1.5; color: #b8c5d1;">
                <strong>MMSI：</strong>${eventData.mmsi || '未知'}<br>
                <strong>座標：</strong>${eventData.coordinates || '待定位'}<br>
                <strong>AIS狀態：</strong>
                <span style="color: ${eventData.aisStatus === '已開啟' ? '#10b981' : '#ef4444'};">
                    ${eventData.aisStatus || '未知'}
                </span><br>
                <strong>建立時間：</strong>${eventData.createTime}<br>
                ${eventData.investigationReason ? `<strong>監控原因：</strong>${eventData.investigationReason}<br>` : ''}
            </div>
        </div>

        <div class="history-track-section">
            <div class="section-title">船舶歷史軌跡檢視</div>
            <div class="history-track-buttons horizontal-scroll">
                <button class="history-track-btn" onclick="jumpToHistoryPoint(0)">現在</button>
                <button class="history-track-btn" onclick="jumpToHistoryPoint(3)">3小時前</button>
                <button class="history-track-btn" onclick="jumpToHistoryPoint(6)">6小時前</button>
                <button class="history-track-btn" onclick="jumpToHistoryPoint(12)">12小時前</button>
                <button class="history-track-btn" onclick="jumpToHistoryPoint(24)">24小時前</button>
                <button class="history-track-btn" onclick="jumpToHistoryPoint(48)">48小時前</button>
                <button class="history-track-btn" onclick="jumpToHistoryPoint(72)">72小時前</button>
                <button class="history-track-btn" onclick="jumpToHistoryPoint(96)">96小時前</button>
                <button class="history-track-btn" onclick="jumpToHistoryPoint(120)">120小時前</button>
            </div>
        </div>

        <div class="risk-assessment-section">
            <div class="section-title">風險評估</div>
            <div class="risk-score-container">
                <div class="risk-score" style="color: ${riskColor};">${riskScore}</div>
                <div class="risk-level" style="color: ${riskColor};">${riskLevel}</div>
            </div>
        </div>

        <!-- <div class="evidence-section">
            <div class="section-title">🔍 風險因子分析</div>
            
            <div class="evidence-item">
                <div class="evidence-title">AIS 異常 (權重: 30%)</div>
                <div class="evidence-desc">
                    長時間關閉 AIS 轉發器，疑似故意隱匿行蹤
                </div>
                <div style="background: rgba(255, 255, 255, 0.1); height: 4px; border-radius: 2px; margin-top: 5px;">
                    <div style="background: #ef4444; height: 100%; width: 90%; border-radius: 2px;"></div>
                </div>
            </div>
            
            <div class="evidence-item">
                <div class="evidence-title">航線偏離 (權重: 25%)</div>
                <div class="evidence-desc">
                    偏離正常商船航道 2.3 公里，進入敏感海域
                </div>
                <div style="background: rgba(255, 255, 255, 0.1); height: 4px; border-radius: 2px; margin-top: 5px;">
                    <div style="background: #f59e0b; height: 100%; width: 75%; border-radius: 2px;"></div>
                </div>
            </div>
            
            <div class="evidence-item">
                <div class="evidence-title">RF 行為 (權重: 20%)</div>
                <div class="evidence-desc">
                    RF 訊號採用非標準加密，疑似規避監控
                </div>
                <div style="background: rgba(255, 255, 255, 0.1); height: 4px; border-radius: 2px; margin-top: 5px;">
                    <div style="background: #ef4444; height: 100%; width: 85%; border-radius: 2px;"></div>
                </div>
            </div>
        </div>  -->

        ${actionSection}
        
        <div class="modal-actions">
            <button class="btn btn-secondary" onclick="rejectAction()">取消</button>
            <button class="btn btn-primary" onclick="executeAction()" id="executeActionBtn">執行行動</button>
        </div>
    `;
}

// 顯示新增事件彈窗
function showNewEventModal() {
    document.getElementById('newEventModal').style.display = 'flex';
    resetEventForm();
}

// 選擇事件類型
function selectEventType(type) {
    selectedEventType = type;
    
    // 更新選中狀態
    document.querySelectorAll('.type-option').forEach(option => {
        option.classList.remove('selected');
    });
    document.querySelector(`[data-type="${type}"]`).classList.add('selected');
    
    // 顯示對應表單
    document.querySelectorAll('.form-section').forEach(form => {
        form.style.display = 'none';
    });
    document.getElementById(`${type}Form`).style.display = 'block';
    
    // 顯示按鈕區域並啟用建立按鈕
    document.getElementById('modalActions').style.display = 'flex';
    document.getElementById('createEventBtn').disabled = false;
}

// 生成單一 RF 信號 ID
function generateSingleRFId() {
    const prefixes = ['SIG'];
    const usedRFIds = new Set();
    
    // 從所有事件中收集已使用的 RF 編號，避免重複
    eventStorage.getAllEvents().forEach(event => {
        if (event.rfCandidates) {
            event.rfCandidates.forEach(rfId => usedRFIds.add(rfId));
        }
        if (event.rfId) {
            usedRFIds.add(event.rfId);
        }
    });
    
    // 從所有海域監測點中收集已使用的 RF 編號
    if (typeof seaDotManager !== 'undefined') {
        seaDotManager.getAllDots().forEach(dot => {
            if (dot.rfId) {
                usedRFIds.add(dot.rfId);
            }
        });
    }
    
    let attempts = 0;
    while (attempts < 100) { // 最大嘗試次數
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const randomHex = Math.random().toString(16).toUpperCase().substr(2, 6);
        const rfId = `${prefix}-${randomHex}`;
        
        // 確保不重複
        if (!usedRFIds.has(rfId)) {
            return rfId;
        }
        attempts++;
    }
    
    // 如果無法生成唯一ID，使用時間戳確保唯一性
    const timestamp = Date.now().toString(16).toUpperCase().substr(-6);
    return `SIG-${timestamp}`;
}

// 修改 RF 候選編號生成器
function generateRandomRFCandidates(count = 3) {
    const candidates = [];
    
    while (candidates.length < count) {
        const candidate = generateSingleRFId();
        if (!candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    }
    
    return candidates;
}

// 為新建立的區域監控事件生成完整的 RF 候選詳細數據
function generateRFCandidatesWithDetails(count, latRange, lonRange) {
    const rfCandidates = generateRandomRFCandidates(count);
    const rfCandidatesData = rfCandidates.map((rfId, index) => {
        let coordinates = '定位中';
        
        if (latRange && lonRange) {
            try {
                coordinates = generateCoordinatesInRange(latRange, lonRange);
            } catch (error) {
                console.warn(`無法為 ${rfId} 生成座標，使用預設範圍:`, error);
            }
        }
        
        const frequency = (150 + Math.random() * 20).toFixed(3);
        const strength = (-60 + Math.random() * 20).toFixed(1);
        
        return {
            rfId: rfId,
            frequency: `${frequency} MHz`,
            strength: `${strength} dBm`,
            coordinates: coordinates,
            index: index
        };
    });
    
    return { rfCandidates, rfCandidatesData };
}

// 禁用/啟用特定事件卡的視覺狀態
function setEventCardDisabled(eventId, disabled) {
    const eventCards = document.querySelectorAll('.event-card');
    eventCards.forEach(card => {
        // 檢查事件卡是否對應指定的事件ID
        const cardEventId = getEventIdFromCard(card);
        if (cardEventId === eventId) {
            if (disabled) {
                card.style.opacity = '0.5';
                card.style.pointerEvents = 'none';
                card.style.filter = 'grayscale(50%)';
            } else {
                card.style.opacity = '';
                card.style.pointerEvents = '';
                card.style.filter = '';
            }
        }
    });
}

/**
 * 建立新事件卡的統一函數（包含狀態更新模擬）
 * @param {string} eventId - 事件ID（大寫格式）
 * @param {string} eventType - 事件類型 ('area', 'rf', 'vessel')
 * @param {Object} eventData - 事件資料
 * @param {Object} displayInfo - 顯示資訊配置
 * @returns {HTMLElement} 新建立的事件卡元素
 */
function createEventCard(eventId, eventType, eventData, displayInfo) {
    const eventIdLowerCase = eventId.toLowerCase();
    
    // 將該事件ID添加到創建中的集合
    creatingEventIds.add(eventIdLowerCase);
    
    // 事件類型配置（包含狀態更新配置）
    const typeConfig = {
        'area': {
            className: 'type-area',
            displayName: '區域監控',
            initialStatus: '建立中',
            delay: 2000,
            finalStatusClass: 'status-investigating',
            finalStatusText: '調查中',
            storageStatus: 'investigating'
        },
        'rf': {
            className: 'type-rf',
            displayName: 'RF 監控',
            initialStatus: '獲取RF資訊中',
            delay: 1500,
            finalStatusClass: 'status-analyzed',
            finalStatusText: '已獲取RF資訊',
            storageStatus: 'analyzed'
        },
        'vessel': {
            className: 'type-vessel',
            displayName: '船舶監控',
            initialStatus: '風險分析中',
            delay: 3000,
            finalStatusClass: 'status-investigating',
            finalStatusText: '等待決策',
            storageStatus: 'investigating'
        }
    };
    
    const config = typeConfig[eventType];
    if (!config) {
        console.error(`不支援的事件類型: ${eventType}`);
        return null;
    }
    
    // 儲存事件資料
    eventStorage.saveEvent(eventIdLowerCase, eventData);
    
    // 建立新事件卡
    const eventsContainer = document.querySelector('.events-container');
    const newCard = document.createElement('div');
    newCard.className = 'event-card';
    newCard.onclick = () => selectEvent(newCard, eventIdLowerCase);
    
    newCard.innerHTML = `
        <div class="event-card-header">
            <span class="event-id">${eventId}</span>
            <span class="event-type-badge ${config.className}">${config.displayName}</span>
        </div>
        <div class="event-info">${displayInfo.content}</div>
        <div class="event-status">
            <div class="status-dot status-creating"></div>
            <span>${config.initialStatus}</span>
        </div>
    `;
    
    // 插入事件卡到容器頂部
    eventsContainer.insertBefore(newCard, eventsContainer.firstChild);
    
    // 立即設置該事件卡為禁用狀態
    setTimeout(() => {
        setEventCardDisabled(eventIdLowerCase, true);
    }, 10);
    
    // 模擬事件狀態更新
    setTimeout(() => {
        const statusDot = newCard.querySelector('.status-dot');
        const statusText = newCard.querySelector('.event-status span');
        
        if (statusDot && statusText) {
            statusDot.className = `status-dot ${config.finalStatusClass}`;
            statusText.textContent = config.finalStatusText;
        }

        // 特殊處理：船舶事件需要更新風險分數顯示
        const updateData = displayInfo.updateData || {};
        if (eventType === 'vessel' && updateData.mmsi && updateData.coordinates && updateData.riskScore) {
            const riskInfo = newCard.querySelector('.event-info');
            if (riskInfo) {
                riskInfo.innerHTML = `MMSI: ${updateData.mmsi}<br>座標: ${updateData.coordinates}<br>風險分數: ${updateData.riskScore}/100`;
            }
        }

        // 更新儲存的事件狀態
        const storageUpdateData = {
            status: config.storageStatus,
            ...updateData
        };
        
        eventStorage.updateEvent(eventIdLowerCase, storageUpdateData);
        
        // 模擬完成後，從創建中的集合移除該事件ID並恢復該事件卡功能
        creatingEventIds.delete(eventIdLowerCase);
        setEventCardDisabled(eventIdLowerCase, false);
    }, config.delay);
    
    console.log(`✅ 事件卡 ${eventId} (${eventType}) 已建立完成`);
    return newCard;
}

// 預設參數

// 台灣西部海域
// 24.1°N - 24.4°N
// 119.2°E - 119.9°E

// 南海海域
// 10.3°N - 18.3°N
// 109.8°E - 118.2°E

// 建立事件
function createNewEvent() {
    const eventId = `${selectedEventType.toUpperCase()}-${String(++eventCounter).padStart(3, '0')}`;
    const eventIdLowerCase = eventId.toLowerCase();
    
    // 建立事件資料結構
    let eventData = {
        type: selectedEventType,
        createTime: new Date().toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'}),
        status: 'creating'
    };
    
    let displayInfo = { content: '', updateData: {} };
    
    if (selectedEventType === 'area') {
        const aoiName = document.getElementById('aoiName').value || '未命名區域';
        
        // 讀取用戶輸入的座標範圍（每個座標值都有獨立的方向選擇）
        const latMin = parseFloat(document.getElementById('latMin').value);
        const latMax = parseFloat(document.getElementById('latMax').value);
        const latMinDirection = document.getElementById('latMinDirection').value;
        const latMaxDirection = document.getElementById('latMaxDirection').value;
        const lonMin = parseFloat(document.getElementById('lonMin').value);
        const lonMax = parseFloat(document.getElementById('lonMax').value);
        const lonMinDirection = document.getElementById('lonMinDirection').value;
        const lonMaxDirection = document.getElementById('lonMaxDirection').value;
        
        let latRange, lonRange;
        
        // 檢查是否有完整的座標輸入
        if (!isNaN(latMin) && !isNaN(latMax) && !isNaN(lonMin) && !isNaN(lonMax)) {
            // 不需要驗證最小值小於最大值，因為用戶可能需要跨越經緯線的範圍
            
            // 轉換為標準格式，每個座標值使用其各自的方向
            latRange = `${latMin.toFixed(1)}°${latMinDirection} - ${latMax.toFixed(1)}°${latMaxDirection}`;
            lonRange = `${lonMin.toFixed(1)}°${lonMinDirection} - ${lonMax.toFixed(1)}°${lonMaxDirection}`;
        } else if (document.getElementById('latMin').value || document.getElementById('latMax').value || 
                   document.getElementById('lonMin').value || document.getElementById('lonMax').value) {
            // 有部分輸入但不完整
            alert('請填寫完整的座標範圍（緯度最小值、最大值、經度最小值、最大值）');
            return;
        } else {
            // 沒有輸入，使用隨機生成的海域範圍
            const randomSeaArea = generateRandomSeaAreaRange();
            latRange = randomSeaArea.latRange;
            lonRange = randomSeaArea.lonRange;
            
            console.log(`為區域監控事件生成隨機海域範圍 - 區域: ${randomSeaArea.area}, 經度: ${lonRange}, 緯度: ${latRange}`);
        }
        
        const monitorHours = document.getElementById('monitorHours').value || '24';

        // 計算監控時間範圍
        const monitorTimeRange = calculateMonitorTimeRange(eventData.createTime, monitorHours);                
        
        // 生成完整的 RF 候選數據
        const candidateCount = Math.floor(Math.random() * 4) + 2;
        const { rfCandidates, rfCandidatesData } = generateRFCandidatesWithDetails(candidateCount, latRange, lonRange);
        
        eventData = {
            ...eventData,
            aoiName: aoiName,
            latRange: latRange,
            lonRange: lonRange,
            monitorHours: monitorHours,
            monitorTimeRange: monitorTimeRange,
            rfCandidates: rfCandidates,
            rfCandidatesData: rfCandidatesData
        };
        
        displayInfo.content = `監控區域: ${aoiName}<br>監控時間: ${monitorTimeRange}`;
        
        console.log(`已為新區域事件 ${eventId} 生成完整的 RF 候選數據:`, rfCandidatesData);
    } else if (selectedEventType === 'rf') {
        const userRfId = document.getElementById('rfId').value;
        const rfNotes = document.getElementById('rfNotes').value || '';
        const detectionTime = new Date().toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'});

        // 嘗試根據 userRfId 找到對應的 sea dot
        let rfId, coordinates, frequency, strength, aisStatus, sourceSeaDot = null;
        
        if (typeof window.seaDotManager !== 'undefined' && window.seaDotManager.getAllDots().length > 0) {
            let targetDot = null;
            
            if (userRfId && userRfId.trim() !== '') {
                // 如果用戶有輸入 RF ID，嘗試找到對應的 sea dot
                targetDot = window.seaDotManager.getDotByRFId(userRfId);
                
                if (!targetDot) {
                    console.warn(`⚠️ 找不到 RF ID "${userRfId}" 對應的 sea dot，將使用隨機選擇`);
                    // 如果找不到對應的 sea dot，隨機選擇一個
                    const allDots = window.seaDotManager.getAllDots();
                    targetDot = allDots[Math.floor(Math.random() * allDots.length)];
                }
            } else {
                // 如果用戶沒有輸入 RF ID，隨機選擇一個 sea dot
                const allDots = window.seaDotManager.getAllDots();
                targetDot = allDots[Math.floor(Math.random() * allDots.length)];
            }
            
            // 使用選中的 sea dot 資訊
            rfId = userRfId || targetDot.rfId; // 如果用戶有輸入 RF ID，優先使用用戶輸入
            coordinates = `${targetDot.lat.toFixed(3)}°N, ${targetDot.lon.toFixed(3)}°E`;
            frequency = (Math.random() * (470 - 430) + 430).toFixed(1) + ' MHz'; // 隨機生成頻率
            strength = Math.floor(Math.random() * 50 + 30) + ' dBm'; // 隨機生成信號強度
            
            // 根據 sea dot 的顏色決定 AIS 狀態（使用 helper）
            const targetDotColor = (typeof getDotColor === 'function') ? getDotColor(targetDot) : (targetDot.dotColor || null);
            if (targetDotColor === '#ef4444' || targetDotColor === 'red') {
                aisStatus = '未開啟';
            } else if (targetDotColor === '#059669' || targetDotColor === 'green') {
                aisStatus = '已開啟';
            } else {
                aisStatus = '未知';
            }

            sourceSeaDot = {
                id: getSafePointId(targetDot),
                status: targetDot.status,
                dotColor: targetDotColor || getDotColor(targetDot),
                area: targetDot.area,
                lat: targetDot.lat,
                lon: targetDot.lon,
                display: {
                    dotColor: targetDotColor || getDotColor(targetDot),
                    backgroundColor: (typeof getBackgroundColor === 'function') ? getBackgroundColor(targetDot) : (targetDot.backgroundColor || targetDotColor || getDotColor(targetDot))
                }
            };
            
            if (userRfId && targetDot.rfId === userRfId) {
                console.log(`✅ RF 事件已從對應的 sea dot ${targetDot.id} 初始化，RF ID: ${rfId}`);
            } else {
                console.log(`✅ RF 事件已從 sea dot ${targetDot.id} 初始化，RF ID: ${rfId} (隨機選擇或用戶輸入)`);
            }
        } else {
            // 如果沒有 seaDotManager 或沒有 sea dots，使用原有的隨機生成方式
            rfId = userRfId || '未知信號';
            coordinates = '待檢測';
            frequency = '待檢測';
            strength = '待檢測';
            aisStatus = '未知';
            
            console.warn('⚠️ SeaDotManager 不可用，RF 事件使用預設值創建');
        }

        eventData = {
            ...eventData,
            rfId: rfId,
            detectionTime: detectionTime,
            notes: rfNotes,
            frequency: frequency,
            strength: strength,
            coordinates: coordinates,
            aisStatus: aisStatus
        };

        // 如果有來源 sea dot，添加到事件資料中
        if (sourceSeaDot) {
            eventData.sourceSeaDot = sourceSeaDot;
        }

        displayInfo.content = `RF 信號 ID: ${rfId}<br>座標: ${eventData.coordinates}`;
    } else if (selectedEventType === 'vessel') {
        const mmsi = document.getElementById('vesselMMSI').value || '未知';
        const vesselName = '未知船舶';
        const investigationReason = document.getElementById('investigationReason').value || '';
        
        // 透過 MMSI 查找相對應的事件資料
        const existingEvent = eventStorage.getEventByShipInfoMMSI(mmsi);
        let coords, trackPoints;
        
        if (existingEvent) {
            // 如果找到相對應的事件，使用其座標和軌跡點資訊
            coords = existingEvent.coordinates;
            trackPoints = existingEvent.trackPoints;
            console.log(`✅ 找到 MMSI ${mmsi} 的現有事件資料，使用其座標和軌跡點`);
        } else {
            console.log(`⚠️ 未找到 MMSI ${mmsi} 的現有事件資料`);
        }
        
        eventData = {
            ...eventData,
            mmsi: mmsi,
            coordinates: coords,
            vesselName: vesselName,
            investigationReason: investigationReason,
            riskScore: 30,
            trackPoints: trackPoints
        };
        
        displayInfo.content = `MMSI: ${mmsi}<br>座標: ${coords}<br>風險分數: ${eventData.riskScore}`;
    }

    closeEventModal();
    
    // 使用統一的事件卡建立函數
    createEventCard(eventId, selectedEventType, eventData, displayInfo);
}

// 重置事件表單
function resetEventForm() {
    selectedEventType = null;
    document.querySelectorAll('.type-option').forEach(option => {
        option.classList.remove('selected');
    });
    document.querySelectorAll('.form-section').forEach(form => {
        form.style.display = 'none';
    });
    // 隱藏按鈕區域並禁用建立按鈕
    document.getElementById('modalActions').style.display = 'none';
    document.getElementById('createEventBtn').disabled = true;
    
    // 清空所有表單欄位
    document.querySelectorAll('.form-input, .form-textarea').forEach(input => {
        input.value = '';
    });
}

// 關閉事件彈窗
function closeEventModal() {
    document.getElementById('newEventModal').style.display = 'none';
}

// 顯示行動決策彈窗
function showActionModal() {
    document.getElementById('actionModal').style.display = 'flex';
    selectedAction = null;
    document.getElementById('executeActionBtn').disabled = true;
    
    // 重置選擇狀態
    document.querySelectorAll('#actionModal .type-option').forEach(option => {
        option.classList.remove('selected');
    });
}

// 生成船舶監控決策建議
function getVesselDecisionRecommendation(riskScore, eventData) {
    let recommendation = {};
    
    // 根據風險分數決定主要建議行動
    if (riskScore >= 75) {
        recommendation = {
            primaryAction: '立即派遣載具調查',
            analysis: '高風險船舶，存在多項異常行為，需要立即進行近距離調查以確認威脅性質。',
            evidence: 'AIS長時間關閉、航線嚴重偏離、RF訊號加密異常',
            priority: '緊急',
            priorityColor: '#ef4444'
        };
    } else if (riskScore >= 60) {
        recommendation = {
            primaryAction: '衛星重拍 + 持續追蹤',
            analysis: '中高風險船舶，建議先透過衛星獲取更多資訊，同時加強追蹤頻率。',
            evidence: '部分異常指標超標，需要更多資料進行評估',
            priority: '高',
            priorityColor: '#f59e0b'
        };
    } else if (riskScore >= 40) {
        recommendation = {
            primaryAction: '持續追蹤監控',
            analysis: '中等風險船舶，保持例行監控即可，定期檢查其行為模式變化。',
            evidence: '風險指標在可控範圍內，但需要持續觀察',
            priority: '中等',
            priorityColor: '#f59e0b'
        };
    } else {
        recommendation = {
            primaryAction: '通知相關單位記錄',
            analysis: '低風險船舶，建議通知相關單位記錄備案即可，無需特殊處理。',
            evidence: '各項指標正常，符合常規航行模式',
            priority: '低',
            priorityColor: '#10b981'
        };
    }
    
    return recommendation;
}

// 儲存已選擇的行動選項
let selectedVesselActions = new Set();

// 切換時間選擇器顯示
function toggleTimeSelector() {
    const scheduledPicker = document.getElementById('scheduledTimePicker');
    const scheduledRadio = document.querySelector('input[name="executeTime"][value="scheduled"]');

    if (scheduledRadio && scheduledRadio.checked) {
        scheduledPicker.style.display = 'block';
    // 設置默認時間為 3 小時後（符合最小時間粒度要求）
    const defaultTime = new Date(Date.now() + 3 * 60 * 60 * 1000);
        document.getElementById('scheduledDateTime').value = defaultTime.toISOString().slice(0, 16);
    } else {
        scheduledPicker.style.display = 'none';
    }
}

// 選擇行動 -> Confirm Button
function selectAction(action, element) {
    selectedAction = action;
    
    // Check if this is from action modal or vessel details
    if (element && element.classList.contains('action-btn')) {
        // This is from vessel details - handle action-btn
        const parentContainer = element.closest('.action-grid');
        if (parentContainer) {
            // Clear all action-btn selections in this container
            parentContainer.querySelectorAll('.action-btn').forEach(btn => {
                btn.classList.remove('selected');
            });
            // Select the clicked button
            element.classList.add('selected');
        }
    } else {
        // This is from action modal - handle type-option
        document.querySelectorAll('#actionModal .type-option').forEach(option => {
            option.classList.remove('selected');
        });
        
        const targetElement = element || event.target.closest('.type-option');
        if (targetElement) {
            targetElement.classList.add('selected');
        }
    }
    
    // 啟用執行按鈕
    const executeBtn = document.getElementById('executeActionBtn');
    if (executeBtn) {
        executeBtn.disabled = false;
    }
}

// 執行行動
function executeAction() {
    console.log('executeAction called, selectedAction:', selectedAction);

    if (!selectedAction) {
        alert('請先選擇一個行動選項！');
        return;
    }

    // 獲取時間選擇
    const executeTimeRadios = document.querySelectorAll('input[name="executeTime"]');
    let executeTime = new Date().toISOString(); // 默認立即執行
    let isScheduled = false;

    console.log('Found executeTime radios:', executeTimeRadios.length);

    executeTimeRadios.forEach(radio => {
        if (radio.checked) {
            console.log('Checked radio value:', radio.value);
            if (radio.value === 'scheduled') {
                const scheduledDateTime = document.getElementById('scheduledDateTime');
                if (scheduledDateTime && scheduledDateTime.value) {
                    const selectedTime = new Date(scheduledDateTime.value);
                    const minTime = new Date(Date.now() + 5 * 60000); // 5分鐘後

                    if (selectedTime < minTime) {
                        alert('排程時間必須在未來至少5分鐘！');
                        return;
                    }

                    executeTime = selectedTime.toISOString();
                    isScheduled = true;
                } else {
                    alert('請選擇排程時間！');
                    return;
                }
            }
        }
    });

    // 獲取目標信息
    const targetInfo = getTargetInfo();
    console.log('Target info:', targetInfo);

    // 檢查missionTrackManager是否存在
    if (typeof missionTrackManager === 'undefined') {
        console.error('missionTrackManager is undefined!');
        alert('系統錯誤：任務管理器未初始化');
        return;
    }

    // Helper: snap a Date to nearest 3-hour block
    function snapTo3Hours(date) {
        const d = new Date(date);
        const ms = 3 * 60 * 60 * 1000;
        const snapped = new Date(Math.round(d.getTime() / ms) * ms);
        return snapped;
    }

    // Helper: find closest current track point for a vessel (prefer type 'Current', fallback to latest 'History')
    function findClosestCurrentPointForVessel(vesselId) {
        try {
            const event = eventStorage.getEvent(vesselId);
            if (!event || !event.trackPoints) return null;
            // prefer type === 'Current'
            const current = event.trackPoints.find(p => p.type === 'Current');
            if (current) return current;
            // else return latest history by timestamp
            const history = event.trackPoints.filter(p => p.type === 'History');
            if (history.length === 0) return null;
            history.sort((a,b)=> new Date(b.timestamp)-new Date(a.timestamp));
            return history[0];
        } catch (err) { console.warn('findClosestCurrentPointForVessel error', err); return null; }
    }

    // Helper: find a future point in vessel's trackPoints that matches scheduledTime (snapped to 3 hours)
    function findFuturePointForVesselByTime(vesselId, scheduledDate) {
        try {
            const event = eventStorage.getEvent(vesselId);
            if (!event || !event.trackPoints) return null;
            const snapped = snapTo3Hours(scheduledDate).getTime();
            // find future point whose snapped time equals
            for (const p of event.trackPoints) {
                if (p.type === 'Future') {
                    const pt = snapTo3Hours(new Date(p.timestamp)).getTime();
                    if (pt === snapped) return p;
                }
            }
            // fallback: nearest future by absolute time diff
            const futures = event.trackPoints.filter(p => p.type === 'Future');
            if (futures.length === 0) return null;
            futures.sort((a,b)=> Math.abs(new Date(a.timestamp)-scheduledDate) - Math.abs(new Date(b.timestamp)-scheduledDate));
            return futures[0];
        } catch (err) { console.warn('findFuturePointForVesselByTime error', err); return null; }
    }

    // 使用統一管理器創建派遣任務，並根據是否為立即/排程自動綁定軌跡點（優先處理 vessel-003 / vessel-004）
    let boundTrackPoint = null;
    const missionPayload = {
        action: selectedAction,
        actionName: actionNames[selectedAction],
        actionIcon: actionIcons[selectedAction],
        targetInfo: targetInfo,
        targetVesselId: currentTrackingVessel || 'all',
        status: isScheduled ? 'scheduled' : 'dispatched',
        timestamp: executeTime,
        isScheduled: isScheduled,
        executeTime: executeTime
    };

    // Only prioritize predefined vessel events (vessel-003, vessel-004)
    const preferredVessels = ['vessel-003', 'vessel-004'];
    const vesselIdToUse = currentTrackingVessel || (preferredVessels.includes(currentEventId) ? currentEventId : null);

    if (!isScheduled) {
        // Immediate: bind to current track point
        if (vesselIdToUse) boundTrackPoint = findClosestCurrentPointForVessel(vesselIdToUse);
    } else {
        // Scheduled: snap to 3-hour and bind to future point matching that time
        const scheduledDate = snapTo3Hours(new Date(executeTime));
        missionPayload.timestamp = scheduledDate.toISOString();
        missionPayload.executeTime = scheduledDate.toISOString();
        if (vesselIdToUse) boundTrackPoint = findFuturePointForVesselByTime(vesselIdToUse, scheduledDate);
    }

    // If we determined a boundTrackPoint, pass its stable id into the mission payload so
    // the mission manager can auto-reuse or link correctly.
    if (boundTrackPoint) {
        missionPayload.sourceTrackPointId = getSafePointId(boundTrackPoint);
    }

    const missionId = missionTrackManager.createMission(missionPayload);

    // If we found a suitable track point, create a persistent link: add missionId to track point and pointId to mission
    if (boundTrackPoint) {
    // ensure the track point is registered in manager
    const pointId = getSafePointId(boundTrackPoint) || null;
        try {
            // If the manager already has this point (by pointId), use it; otherwise, create it
            let managerPointId = pointId && missionTrackManager.trackPoints.has(pointId) ? pointId : null;
            // If the point already exists in manager, ensure it's not owned by another mission
            if (managerPointId) {
                const existingPoint = missionTrackManager.trackPoints.get(managerPointId);
                if (existingPoint && existingPoint.boundMissionId && existingPoint.boundMissionId !== missionId) {
                    console.warn(`Explicit bind skipped: track point ${managerPointId} already bound to another mission.`);
                } else {
                    // safe to bind one-to-one
                    const mission = missionTrackManager.missions.get(missionId);
                    if (mission) mission.boundPointId = managerPointId;
                    const mp = missionTrackManager.trackPoints.get(managerPointId);
                    if (mp) mp.boundMissionId = missionId;
                    missionTrackManager.missionTrackLinks.set(`${missionId}-${managerPointId}`, { missionId, pointId: managerPointId, linkTime: new Date().toISOString(), linkReason: 'explicit_bind' });
                    console.log('Mission bound to track point:', missionId, managerPointId);
                }
            } else {
                // create a new track point in manager and bind it (newly created point has no existing boundMissionId)
                managerPointId = missionTrackManager.createTrackPoint(boundTrackPoint);
                const mission = missionTrackManager.missions.get(missionId);
                if (mission) mission.boundPointId = managerPointId;
                const mp = missionTrackManager.trackPoints.get(managerPointId);
                if (mp) mp.boundMissionId = missionId;
                missionTrackManager.missionTrackLinks.set(`${missionId}-${managerPointId}`, { missionId, pointId: managerPointId, linkTime: new Date().toISOString(), linkReason: 'explicit_bind' });
                console.log('Mission bound to track point (new):', missionId, managerPointId);
            }
        } catch (err) { console.warn('Error binding mission to track point', err); }
    }

    console.log('Created mission with ID:', missionId);

    // 創建新任務卡
    const missionTimeline = document.querySelector('.mission-list');
    console.log('Mission timeline element found:', !!missionTimeline);

    if (!missionTimeline) {
        console.error('Mission timeline element not found!');
        alert('錯誤：找不到任務列表容器');
        return;
    }

    const newMission = document.createElement('div');
    newMission.className = 'mission-card';
    newMission.setAttribute('data-mission-id', missionId);

    const executeTimeFormatted = new Date(executeTime).toLocaleString('zh-TW');
    const statusText = isScheduled ? '排程' : '派遣';
    const statusClass = isScheduled ? 'status-scheduled' : 'status-dispatched';

    console.log('Creating mission card with:', {
        missionId,
        selectedAction,
        targetInfo,
        executeTimeFormatted,
        statusText,
        statusClass
    });

    newMission.innerHTML = `
        <div class="mission-card-header">
            <span class="mission-type">${actionIcons[selectedAction]} ${actionNames[selectedAction]}</span>
            <span class="mission-status ${statusClass}">${statusText}</span>
        </div>
        <div class="mission-details">
            目標: ${targetInfo}<br>
            ${isScheduled ? '預定執行' : '排程'}: ${executeTimeFormatted}
        </div>
        <div class="mission-progress">
            <div class="progress-bar">
                <div class="progress-fill" style="width: 0%;"></div>
            </div>
            <div class="progress-text">${isScheduled ? '等待排程時間' : '等待執行'}</div>
        </div>
    `;

    missionTimeline.insertBefore(newMission, missionTimeline.firstChild);
    console.log('Mission card inserted into timeline');

    // 验证任务卡是否成功添加
    const insertedCard = document.querySelector(`[data-mission-id="${missionId}"]`);
    console.log('Mission card found after insertion:', !!insertedCard);

    // 为任务卡添加点击事件
    newMission.addEventListener('click', () => {
        highlightMissionCard(missionId);
        showMissionDetails(missionId);
    });
    newMission.style.cursor = 'pointer';

    // 顯示船舶圖片
    showShipPicture();

    // 更新任務統計
    const stats = document.querySelector('.mission-stats');
    const currentActive = parseInt(stats.textContent.match(/進行中: (\d+)/)[1]) + 1;
    const currentTotal = parseInt(stats.textContent.match(/總計: (\d+)/)[1]) + 1;
    stats.textContent = `進行中: ${currentActive} | 已完成: 1 | 總計: ${currentTotal}`;

    // 新增：更新右侧时间轴
    const actionIcon = selectedAction === 'satellite' ? '🛰️' : selectedAction === 'uav' ? '🚁' : selectedAction === 'track' ? '🎯' : '📞';
    const timelineStatus = isScheduled ? '排程' : '派遣';
    addTimelineEvent(timelineStatus, `${actionIcon} ${targetInfo}`, `${actionNames[selectedAction]}${isScheduled ? ' (預定執行)' : ''}`, missionId);

    // 設置任務執行時間
    const executionDelay = isScheduled ?
        Math.max(0, new Date(executeTime) - new Date()) :
        3000; // 立即執行任務延遲3秒

    // 模擬任務進度
    setTimeout(() => {
        const statusBadge = newMission.querySelector('.mission-status');
        const progressFill = newMission.querySelector('.progress-fill');
        const progressText = newMission.querySelector('.progress-text');

        if (!statusBadge) return; // 任務卡可能已被移除

        // 開始執行任務
        statusBadge.className = 'mission-status status-arrived';
        statusBadge.textContent = '抵達';

        setTimeout(() => {
            if (!statusBadge.parentElement) return; // 檢查元素是否還存在
            statusBadge.className = 'mission-status status-executing';
            statusBadge.textContent = '執行任務';
        }, 2000);

        let progress = 0;
        const interval = setInterval(() => {
            if (!progressFill || !progressText) {
                clearInterval(interval);
                return;
            }

            progress += Math.random() * 20;
            if (progress > 100) progress = 100;

            progressFill.style.width = progress + '%';
            progressText.textContent = `進度: ${Math.round(progress)}%`;

            if (progress >= 100) {
                clearInterval(interval);
                if (statusBadge && statusBadge.parentElement) {
                    statusBadge.className = 'mission-status status-completed';
                    statusBadge.textContent = '完成';
                    progressText.textContent = '已完成';

                    // 更新任務狀態到統一管理器
                    const mission = missionTrackManager.missions.get(missionId);
                    if (mission) {
                        mission.status = 'completed';
                        mission.completedTime = new Date().toISOString();
                    }

                    // 更新統計
                    const newStats = document.querySelector('.mission-stats');
                    if (newStats) {
                        const activeCount = Math.max(0, parseInt(newStats.textContent.match(/進行中: (\d+)/)[1]) - 1);
                        const completedCount = parseInt(newStats.textContent.match(/已完成: (\d+)/)[1]) + 1;
                        const totalCount = parseInt(newStats.textContent.match(/總計: (\d+)/)[1]);
                        newStats.textContent = `進行中: ${activeCount} | 已完成: ${completedCount} | 總計: ${totalCount}`;
                    }
                }
            }
        }, 1000);
    }, executionDelay);

    // 重置選項
    selectedAction = null;

    // 清除所有選中狀態
    document.querySelectorAll('.action-btn').forEach(btn => {
        btn.classList.remove('selected');
    });

    // 隱藏彈窗
    hideConfirmationModal();
}

// 隱藏確認模態框
function hideConfirmationModal() {
    // 尋找並關閉可能的模態框
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
        if (modal.style.display === 'block' || modal.style.display === 'flex') {
            modal.style.display = 'none';
        }
    });

    // 特定模態框ID的關閉
    const confirmationModal = document.getElementById('confirmationModal');
    if (confirmationModal) {
        confirmationModal.style.display = 'none';
    }

    const detailsModal = document.getElementById('detailsModal');
    if (detailsModal) {
        detailsModal.style.display = 'none';
    }
}

// 拒絕行動
function rejectAction() {
    return 'reject';
}

// 從 AreaEventDetails 中提取指定 RF 候選的數據
function extractRFCandidateData(rfId) {
    // 獲取來源區域事件的資料
    const sourceAreaEvent = eventStorage.getEvent(currentEventId);
    
    // 優先從儲存的 rfCandidatesData 中提取數據
    if (sourceAreaEvent && sourceAreaEvent.rfCandidatesData) {
        const candidateData = sourceAreaEvent.rfCandidatesData.find(data => data.rfId === rfId);
        if (candidateData) {
            console.log(`從儲存數據提取的 RF 數據 (${rfId}):`, candidateData);
            return {
                frequency: candidateData.frequency,
                strength: candidateData.strength,
                coordinates: candidateData.coordinates
            };
        }
    }
    
    const detailsContent = document.getElementById('detailsContent');
    const evidenceItems = detailsContent.querySelectorAll('.evidence-item');
    
    let extractedData = null;
    let foundInPanel = false;
    
    // 遍歷所有證據項目，尋找匹配的 RF ID
    evidenceItems.forEach(item => {
        const titleElement = item.querySelector('.evidence-title');
        const descElement = item.querySelector('.evidence-desc');
        
        if (titleElement && titleElement.textContent.includes(rfId)) {
            foundInPanel = true;
            const descText = descElement.textContent;
            
            extractedData = {
                frequency: '待檢測',
                strength: '待檢測', 
                coordinates: '定位中'
            };
            
            // 提取頻率資訊
            const frequencyMatch = descText.match(/📡 頻率:\s*([^\|]+)/);
            if (frequencyMatch) {
                extractedData.frequency = frequencyMatch[1].trim();
            }
            
            // 提取強度資訊
            const strengthMatch = descText.match(/強度:\s*([^\n]+)/);
            if (strengthMatch) {
                extractedData.strength = strengthMatch[1].trim();
            }
            
            // 提取座標資訊
            const coordinatesMatch = descText.match(/📍 座標:\s*([^\n]+)/);
            if (coordinatesMatch) {
                extractedData.coordinates = coordinatesMatch[1].trim();
            }
        }
    });
    
    // 如果在詳情面板中找到了數據，使用它
    if (foundInPanel && extractedData) {
        console.log(`從詳情面板提取的 RF 數據 (${rfId}):`, extractedData);
        return extractedData;
    }
    
    // 如果沒有找到數據，則隨機生成
    console.log(`未在詳情面板找到 RF 數據 (${rfId})，正在隨機生成...`);
    
    // 隨機生成頻率 (MHz)
    const frequencies = ['118.125', '121.500', '123.450', '124.200', '126.900', '131.725', '134.575'];
    const randomFrequency = frequencies[Math.floor(Math.random() * frequencies.length)] + ' MHz';
    
    // 隨機生成強度 (dBm)
    const minStrength = -80;
    const maxStrength = -30;
    const randomStrength = (Math.random() * (maxStrength - minStrength) + minStrength).toFixed(1) + ' dBm';
    
    // 隨機生成台灣周遭海域座標
    const randomCoordinates = generateSeaCoordinateForEvents(); // 直接使用函數返回的座標字串
    
    const generatedData = {
        frequency: randomFrequency,
        strength: randomStrength,
        coordinates: randomCoordinates
    };
    
    console.log(`隨機生成的 RF 數據 (${rfId}):`, generatedData);
    return generatedData;
    return extractedData;
}

// 從區域監控建立 RF 事件（從 AreaEventDetails 提取數據）
function createRFEventfromArea(rfId, customCoordinates = null) {
    // 禁用對應的按鈕，防止重複點擊
    const buttons = document.querySelectorAll('.create-rf-btn');

    const eventId = `RF-${String(++eventCounter).padStart(3, '0')}`;
    const eventIdLowerCase = eventId.toLowerCase();
    
    // 將該事件ID添加到創建中的集合
    creatingEventIds.add(eventIdLowerCase);
    
    // 獲取來源區域事件的資料
    const sourceAreaEvent = eventStorage.getEvent(currentEventId);
    
    // 從當前詳情面板中提取對應 RF 候選的數據
    let rfCandidateData = extractRFCandidateData(rfId);
    
    // 如果有傳入自定義座標，優先使用；否則使用原有機制
    if (customCoordinates) {
        console.log(`📍 使用傳入的自定義座標: ${customCoordinates}`);
        rfCandidateData.coordinates = customCoordinates;
    } else {
        console.log(`📍 使用原有機制獲取的座標: ${rfCandidateData.coordinates}`);
    }
    
    // 嘗試從來源區域事件的 rfCandidatesData 中取得完整資訊
    let aisStatus = '未知';
    let sourceSeaDot = null;
    
    if (sourceAreaEvent && sourceAreaEvent.rfCandidatesData) {
        const candidateDetail = sourceAreaEvent.rfCandidatesData.find(data => data.rfId === rfId);
        if (candidateDetail && candidateDetail.aisStatus) {
            aisStatus = candidateDetail.aisStatus;
        }
        if (candidateDetail && candidateDetail.sourceSeaDot) {
            sourceSeaDot = candidateDetail.sourceSeaDot;
        }
    }
    
    // 如果仍然沒有AIS狀態，嘗試從seaDotManager獲取
    if (aisStatus === '未知' && typeof window.seaDotManager !== 'undefined') {
        const dot = window.seaDotManager.getDotByRFId(rfId);
        if (dot) {
            const resolvedColor = (typeof getDotColor === 'function') ? getDotColor(dot) : (dot.dotColor || null);
            if (resolvedColor === '#ef4444' || resolvedColor === 'red') {
                aisStatus = '未開啟';
            } else if (resolvedColor === '#059669' || resolvedColor === 'green') {
                aisStatus = '已開啟';
            }
                sourceSeaDot = {
                    id: getSafePointId(dot) || dot.id,
                    status: dot.status,
                    dotColor: (typeof getDotColor === 'function') ? (resolvedColor || getDotColor(dot)) : (resolvedColor || dot.dotColor),
                    area: dot.area,
                    lat: dot.lat,
                    lon: dot.lon,
                    display: {
                        dotColor: (typeof getDotColor === 'function') ? (resolvedColor || getDotColor(dot)) : (resolvedColor || dot.dotColor),
                        backgroundColor: (typeof getBackgroundColor === 'function') ? (getBackgroundColor(dot) || dot.backgroundColor || resolvedColor || ((typeof getDotColor === 'function') ? getDotColor(dot) : dot.dotColor)) : (dot.backgroundColor || resolvedColor || ((typeof getDotColor === 'function') ? getDotColor(dot) : dot.dotColor))
                    }
                };
        }
    }
    
    // 建立 RF 事件資料，確保AIS狀態一致
    let eventData = {
        type: 'rf',
        rfId: rfId,
        createTime: new Date().toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'}),
        detectionTime: new Date().toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'}),
        status: 'creating',
        frequency: rfCandidateData.frequency,
        strength: rfCandidateData.strength,
        coordinates: rfCandidateData.coordinates,
        aisStatus: aisStatus, // 確保使用一致的AIS狀態
        notes: `從 ${currentEventId.toUpperCase()} 區域監控事件建立的 RF 異常調查`
    };
    
    // 如果有來源sea dot資訊，加入事件資料
    if (sourceSeaDot) {
        eventData.sourceSeaDot = sourceSeaDot;
    }
    
    // 如果有來源區域事件，添加關聯資訊
    if (sourceAreaEvent && sourceAreaEvent.type === 'area') {
        eventData.sourceAreaEvent = sourceAreaEvent.id;
        eventData.aoiName = sourceAreaEvent.aoiName;
    }
    
    // 儲存 RF 事件資料到 eventStorage
    eventStorage.saveEvent(eventId.toLowerCase(), eventData);
    
    // 準備顯示資訊
    const displayInfo = {
        content: `RF 信號 ID: ${rfId}<br>座標: ${eventData.coordinates}`
    };
    
    // 使用統一的事件卡建立函數
    createEventCard(eventId, 'rf', eventData, displayInfo);
    
    // 從來源區域事件中移除已建立的 RF 候選（如果存在）
    if (sourceAreaEvent && sourceAreaEvent.rfCandidates) {
        const updatedCandidates = sourceAreaEvent.rfCandidates.filter(candidate => candidate !== rfId);
        const updatedCandidatesData = sourceAreaEvent.rfCandidatesData.filter(data => data.rfId !== rfId);
        
        eventStorage.updateEvent(currentEventId, { 
            rfCandidates: updatedCandidates,
            rfCandidatesData: updatedCandidatesData
        });
        
        // 更新區域事件的詳情面板
        setTimeout(() => {
            if (currentEventId === sourceAreaEvent.id) {
                updateDetailsPanel(currentEventId);
            }
        }, 2000);
    }
    
    console.log(`RF 事件 ${eventId} 已從區域事件 ${currentEventId.toUpperCase()} 建立完成`);
}

// TODO 生成船舶監控事件後將可疑列表中的對應船隻移除
// 從 RF 事件建立船舶監控
function createVesselEventFromRF() {
    const eventId = `VESSEL-${String(++eventCounter).padStart(3, '0')}`;
    const eventIdLowerCase = eventId.toLowerCase();
    
    // 將該事件ID添加到創建中的集合
    creatingEventIds.add(eventIdLowerCase);
    
    // 獲取當前 RF 事件的資料
    const currentRFEvent = eventStorage.getEvent(currentEventId);
    if (!currentRFEvent || currentRFEvent.type !== 'rf') {
        console.error('無法從非 RF 事件建立船舶監控');
        return;
    }
    
    // 從當前 RF 事件提取數據來建立船舶監控
    const currentTime = new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    const mmsi = `416${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
    
    let eventData = {
        id: eventId,
        type: 'vessel',
        mmsi: mmsi,
        coordinates: currentRFEvent.coordinates,
        vesselName: '未知船舶',
        riskScore: Math.floor(Math.random() * 16) + 70, // 70-85
        createTime: currentTime,
        status: 'investigating',
        investigationReason: 'RF 信號異常，疑似 AIS 關閉或偽造',
        sourceRFEvent: currentRFEvent.id,
        frequency: currentRFEvent.frequency,
        signalStrength: currentRFEvent.signalStrength,
        trackPoints: null // 稍後生成固定軌跡點
    };
    
    // TODO 從 RF 事件生成船舶調查事件時的軌跡點生成機制
    // 為vessel event生成固定的track points
    // try {
    //     const coords = parsePointCoordinates(currentRFEvent.coordinates);
    //     if (coords) {
    //         eventData.trackPoints = eventStorage.generateFixedTrackPoints(eventData.id, coords.lat, coords.lon);
    //         console.log(`✅ 為新建船舶事件 ${eventId} 生成了固定的軌跡點`);
    //     }
    // } catch (error) {
    //     console.warn(`⚠️ 為船舶事件 ${eventId} 生成軌跡點時發生錯誤:`, error);
    // }
    
    // 如果 RF 事件有來源區域事件，繼承關聯資訊
    if (currentRFEvent.sourceAreaEvent) {
        eventData.sourceAreaEvent = currentRFEvent.sourceAreaEvent;
        eventData.aoiName = currentRFEvent.aoiName;
    }
    
    // 儲存船舶監控事件資料到 eventStorage
    eventStorage.saveEvent(eventId.toLowerCase(), eventData);
    
    // 準備顯示資訊
    const displayInfo = {
        content: `MMSI: ${eventData.mmsi}<br>座標: ${currentRFEvent.coordinates}<br>風險分數: 分析中`,
        updateData: {
            mmsi: eventData.mmsi,
            coordinates: eventData.coordinates,
            riskScore: eventData.riskScore
        }
    };
    
    // 使用統一的事件卡建立函數
    createEventCard(eventId, 'vessel', eventData, displayInfo);
    console.log(`船舶監控事件 ${eventId} 已從 RF 事件 ${currentRFEvent.id} 建立完成`);
}

// 其他操作函數
function refreshAOI() {
    alert('🔄 重新掃描 AOI 區域...\n正在更新 RF 異常候選清單');
}

function expandAOI() {
    alert('📏 擴大 AOI 範圍...\n監控區域已增加 20%');
}

function exportData() {
    alert('📊 匯出資料...\n事件資料已匯出為 CSV 檔案');
}

function analyzeRF() {
    alert('🔍 深度分析 RF 信號...\n正在進行頻譜分析與模式比對');
}

function exportRFData() {
    alert('📊 匯出 RF 資料...\n信號資料已匯出為技術報告');
}

function closeEvent() {
    if (confirm('確定要結束此事件嗎？\n結束後事件將移至歷史資料庫')) {
        const activeCard = document.querySelector('.event-card.active');
        if (activeCard) {
            const statusDot = activeCard.querySelector('.status-dot');
            const statusText = activeCard.querySelector('.event-status span');
            statusDot.className = 'status-dot status-completed';
            statusText.textContent = '已結束';
            
            alert('✅ 事件已結束並封存至歷史資料庫');
        }
    }
}

// 台灣地圖
// ✅ 在這裡加入地圖相關變數和函數
let taiwanMap = null;

// === SeaDot 動態縮放系統 ===
/**
 * 根據地圖縮放等級計算 SeaDot 的動態大小
 * @param {L.Map} map - Leaflet 地圖實例
 * @param {Object} options - 大小配置選項
 * @returns {Object} 包含 width, height, iconSize, iconAnchor 的物件
 */
function calculateSeaDotSize(map, options = {}) {
    if (!map) {
        // 如果沒有地圖實例，返回預設大小
        return {
            width: 16,
            height: 16,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        };
    }

    // 配置參數
    const config = {
        baseSize: options.baseSize || 16,           // 基礎大小 (zoom = 7 時的大小)
        baseZoom: options.baseZoom || 7,            // 基準縮放等級
        scaleFactor: options.scaleFactor || 1.1,   // 每級縮放的倍數
        minSize: options.minSize || 12,              // 最小大小
        maxSize: options.maxSize || 20              // 最大大小
    };

    const currentZoom = map.getZoom();
    const zoomDifference = currentZoom - config.baseZoom;
    
    // 計算動態大小：基礎大小 * (縮放係數 ^ 縮放差異)
    let dynamicSize = config.baseSize * Math.pow(config.scaleFactor, zoomDifference);
    
    // 限制在最小和最大範圍內
    dynamicSize = Math.max(config.minSize, Math.min(config.maxSize, dynamicSize));
    dynamicSize = Math.round(dynamicSize);

    // 計算圖示大小（通常比實際圓點大一些）
    const iconSize = dynamicSize + 4;
    const iconAnchor = Math.round(iconSize / 2);

    return {
        width: dynamicSize,
        height: dynamicSize,
        iconSize: [iconSize, iconSize],
        iconAnchor: [iconAnchor, iconAnchor]
    };
}

/**
 * 更新現有 SeaDot 標記的大小
 * @param {L.Marker} marker - Leaflet 標記實例  
 * @param {Object} sizes - 新的大小參數
 * @param {Object} dotData - SeaDot 資料
 */
function updateSeaDotMarkerSize(marker, sizes, dotData) {
    if (!marker || !marker.getElement()) return;

    try {
        // 獲取當前圖示選項
        const currentIcon = marker.getIcon();
        let borderStyle = '';
        let shadowColor = 'rgba(102, 231, 255, 0.6)';
        
        // 重新計算樣式
        const udColor = getDotColor(dotData);
        if (udColor === 'none') {
            borderStyle = 'border: none;';
            shadowColor = 'rgba(102, 231, 255, 0.6)';
        } else {
            shadowColor = window.seaDotManager ? 
                window.seaDotManager.hexToRgba(udColor, 0.6) : 
                'rgba(102, 231, 255, 0.6)';
            borderStyle = `border: 2px solid ${udColor};`;
        }
        
        // 創建新的圖示，使用統一的圖示生成函數
        const newIcon = window.seaDotManager.createSeaDotIcon(dotData, sizes, shadowColor, borderStyle);
        
        // 設置新圖示
        marker.setIcon(newIcon);
        
    } catch (error) {
        console.warn('更新 SeaDot 大小時發生錯誤:', error);
    }
}

// SeaDotManager 已抽出至 UIUX/map/SeaDotManager.js
// 在地圖初始化完成後請呼叫 `window.__attachSeaDotManager()` 以建立全域實例。

// 地圖初始化函數
function initializeTaiwanMap() {
    try {
        // 台灣中心座標
        const taiwanCenter = [23.8, 121.0];
        
        // 建立地圖
        taiwanMap = L.map('taiwanMap', {
            center: taiwanCenter,
            zoom: 7,
            minZoom: 3,//6
            maxZoom: 18,
            zoomControl: true,
            // 優化觸控和拖拽行為
            touchZoom: true,
            doubleClickZoom: true,
            scrollWheelZoom: true,
            boxZoom: true,
            keyboard: true,
            dragging: true,
            // 設定拖拽慣性
            inertia: true,
            inertiaDeceleration: 3000,
            inertiaMaxSpeed: 1500
        });
        
        // 加入海圖圖層（暗色主題，適合海事用途）
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap contributors © CARTO',
            subdomains: 'abcd',
            maxZoom: 19
        }).addTo(taiwanMap);
        
        // 動態偏移量計算函數
        function calculateDynamicOffset(baseOffset, minOffset = null) {
            const currentZoom = taiwanMap.getZoom();
            const baseZoom = 7; // 基礎縮放等級（地圖初始化時的縮放等級）
            
            // 如果沒有指定最小偏移量，則使用基礎偏移量的5%作為最小值
            if (minOffset === null) {
                minOffset = Math.abs(baseOffset) * 0.05;
                if (baseOffset < 0) minOffset = -minOffset; // 保持符號一致
            }
            
            // 計算縮放比例因子：縮放等級越高，因子越小
            const zoomFactor = Math.pow(0.5, Math.max(0, currentZoom - baseZoom));
            const dynamicOffset = baseOffset >= 0 
                ? Math.max(minOffset, baseOffset * zoomFactor)
                : Math.min(minOffset, baseOffset * zoomFactor); // 處理負偏移量
            
            return dynamicOffset;
        }
        
        // 添加簡單的經緯度參考線（自定義實現）
        function addLatLngGrid() {
            const bounds = taiwanMap.getBounds();
            const gridLines = [];
            
            // 繪製經線（垂直線）
            for (let lng = Math.floor(bounds.getWest()); lng <= Math.ceil(bounds.getEast()); lng += 1) {
                const line = L.polyline([
                    [bounds.getSouth(), lng],
                    [bounds.getNorth(), lng]
                ], {
                    color: '#ffffff',
                    weight: 1,
                    opacity: 0.4,
                    dashArray: '2, 4'
                });
                gridLines.push(line);
                
                // 計算經度標籤的動態偏移量
                const longitudeOffset = calculateDynamicOffset(0.4, 0.02);
                
                console.log(`Zoom: ${taiwanMap.getZoom()}, Longitude Offset: ${longitudeOffset.toFixed(4)}`);
                
                // 添加經度標籤（置下，使用動態偏移量）
                const label = L.marker([bounds.getSouth() + longitudeOffset, lng], {
                    icon: L.divIcon({
                        html: `<div style="color: white; font-size: 12px; font-weight: bold;">${lng}°E</div>`,
                        className: 'grid-label',
                        iconSize: [40, 20],
                        iconAnchor: [20, 0]  // 下對齊：錨點設為上邊緣
                    })
                });
                gridLines.push(label);
            }
            
            // 繪製緯線（水平線）
            for (let lat = Math.floor(bounds.getSouth()); lat <= Math.ceil(bounds.getNorth()); lat += 1) {
                const line = L.polyline([
                    [lat, bounds.getWest()],
                    [lat, bounds.getEast()]
                ], {
                    color: '#ffffff',
                    weight: 1,
                    opacity: 0.4,
                    dashArray: '2, 4'
                });
                gridLines.push(line);
                
                // 計算緯度標籤的動態偏移量
                const latitudeOffset = calculateDynamicOffset(-0.05, -0.0025);
                
                console.log(`Zoom: ${taiwanMap.getZoom()}, Latitude Offset: ${latitudeOffset.toFixed(4)}`);
                
                // 添加緯度標籤（置右，使用動態偏移量）
                const label = L.marker([lat, bounds.getEast() + latitudeOffset], {
                    icon: L.divIcon({
                        html: `<div style="color: white; font-size: 12px; font-weight: bold;">${lat}°N</div>`,
                        className: 'grid-label',
                        iconSize: [40, 20],
                        iconAnchor: [40, 10]  // 右對齊：錨點設為右邊緣
                    })
                });
                gridLines.push(label);
            }
            
            // 將網格線添加到地圖
            const gridGroup = L.layerGroup(gridLines);
            gridGroup.addTo(taiwanMap);
            
            // 存儲網格組以便後續更新
            window.gridGroup = gridGroup;
        }
        
        // 地圖移動時更新網格
        taiwanMap.on('moveend zoomend', function() {
            if (window.gridGroup) {
                taiwanMap.removeLayer(window.gridGroup);
                addLatLngGrid();
            }
        });
        
        // 初始添加網格
        setTimeout(addLatLngGrid, 1000);
        
        // 限制地圖範圍到台灣周圍
        /*
        const taiwanBounds = [
            [20.0, 118.0], // 西南角
            [26.5, 124.0]  // 東北角
        ];
        taiwanMap.setMaxBounds(taiwanBounds);
        */
        
        // 添加地圖事件監聽器來確保指針樣式正確
        taiwanMap.getContainer().style.cursor = 'grab';
        
        taiwanMap.on('mousedown', function() {
            taiwanMap.getContainer().style.cursor = 'grabbing';
        });
        
        taiwanMap.on('mouseup', function() {
            taiwanMap.getContainer().style.cursor = 'grab';
        });

        // === SeaDot 動態縮放事件監聽器 ===
        taiwanMap.on('zoomend', function() {
            const currentZoom = taiwanMap.getZoom();
            console.log(`🔍 地圖縮放變化: ${currentZoom}, 正在更新 SeaDot 大小...`);
            
            // 更新所有 SeaDot 的大小
            if (window.seaDotManager) {
                window.seaDotManager.updateAllSeaDotSizes(taiwanMap);
            }
        });
        
        console.log('✅ 台灣地圖初始化成功');
        
        // 加入隨機藍色圓點
        addRandomSeaDots();

        // 嘗試建立全域 seaDotManager（如果 SeaDotManager 已抽出並可用）
        if (window.__attachSeaDotManager) {
            const attached = window.__attachSeaDotManager();
            if (!attached) {
                console.log('SeaDotManager 尚未可用，稍後可重試 attach');
            }
        }
        
    } catch (error) {
        console.error('❌ 地圖初始化失敗:', error);
    }
}

// 生成隨機藍色海域圓點
function addRandomSeaDots() {
    if (!taiwanMap) return;

    // 確保全域 seaDotManager 已建立：若尚未建立則嘗試 attach，若 attach 不成功則延遲重試
    if (typeof window.seaDotManager === 'undefined') {
        if (typeof window.__attachSeaDotManager === 'function') {
            const ok = window.__attachSeaDotManager();
            if (!ok) {
                // 延遲並重試，避免載入順序 race 導致不生成點
                console.log('等待 SeaDotManager 可用，稍後重試生成 SeaDots...');
                setTimeout(addRandomSeaDots, 200);
                return;
            }
        } else {
            // 如果沒有 attach helper，也延遲重試（保守處理）
            console.log('SeaDotManager 尚未定義，稍後重試生成 SeaDots...');
            setTimeout(addRandomSeaDots, 200);
            return;
        }
    }
    
    // 定義台灣本島的大致範圍（避免在陸地上放置圓點）
    const taiwanLandAreas = [
        // 台灣本島主要區域
        { latMin: 21.9, latMax: 25.3, lonMin: 120.0, lonMax: 122.0 },
    ];
    
    // 定義海域範圍（台灣周圍海域 + 南海區域）
    const seaAreas = [
        // 台灣海峽西側
        { latMin: 22.0, latMax: 25.5, lonMin: 119.0, lonMax: 119.8, name: '台灣海峽西側' },
        // 東部海域
        { latMin: 22.0, latMax: 25.5, lonMin: 121.5, lonMax: 122.5, name: '台灣東部海域' },
        // 北部海域
        // { latMin: 25.0, latMax: 26.0, lonMin: 120.0, lonMax: 122.0, name: '台灣北部海域' },
        // 南部海域
        { latMin: 21.5, latMax: 22.5, lonMin: 120.0, lonMax: 121.5, name: '台灣南部海域' },
        // 巴士海峽
        { latMin: 20.5, latMax: 22.0, lonMin: 120.5, lonMax: 121.8, name: '巴士海峽' },
        // 台灣海峽中央
        { latMin: 23.5, latMax: 24.5, lonMin: 119.2, lonMax: 119.9, name: '台灣海峽中央' },
        
        // === 南海區域 ===
        // 南海北部（海南島以南）
        { latMin: 16.0, latMax: 20.0, lonMin: 108.0, lonMax: 114.0, name: '南海北部海域' },
        // 西沙群島周邊
        { latMin: 15.5, latMax: 17.5, lonMin: 111.0, lonMax: 113.0, name: '西沙群島海域' },
        // 中沙群島周邊
        { latMin: 13.5, latMax: 16.0, lonMin: 113.5, lonMax: 115.5, name: '中沙群島海域' },
        // 南沙群島北部
        { latMin: 7.0, latMax: 12.0, lonMin: 109.0, lonMax: 116.0, name: '南沙群島北部海域' },
        // 南沙群島南部
        { latMin: 4.0, latMax: 8.0, lonMin: 111.0, lonMax: 114.0, name: '南沙群島南部海域' },
        // 南海中央海盆
        { latMin: 10.0, latMax: 18.0, lonMin: 114.0, lonMax: 118.0, name: '南海中央海盆' },
        // 南海東北部（菲律賓以西）
        { latMin: 14.0, latMax: 20.0, lonMin: 116.0, lonMax: 120.0, name: '南海東北部海域' },
        // 南海東南部
        { latMin: 6.0, latMax: 12.0, lonMin: 116.0, lonMax: 119.0, name: '南海東南部海域' }
    ];
    
    // 檢查座標是否在台灣陸地範圍內
    function isOnLand(lat, lon) {
        return taiwanLandAreas.some(area => 
            lat >= area.latMin && lat <= area.latMax && 
            lon >= area.lonMin && lon <= area.lonMax
        );
    }
    
    // 生成隨機海域座標
    function generateSeaCoordinate() {
        const maxAttempts = 20;
        let attempts = 0;
        
        while (attempts < maxAttempts) {
            // 隨機選擇一個海域
            const seaArea = seaAreas[Math.floor(Math.random() * seaAreas.length)];
            
            // 在該海域內生成隨機座標
            const lat = seaArea.latMin + Math.random() * (seaArea.latMax - seaArea.latMin);
            const lon = seaArea.lonMin + Math.random() * (seaArea.lonMax - seaArea.lonMin);
            
            // 檢查是否在陸地上
            if (!isOnLand(lat, lon)) {
                return { lat, lon, area: seaArea.name };
            }
            
            attempts++;
        }
        
        // 如果多次嘗試都失敗，使用預設的海域座標
        return { lat: 24.0, lon: 119.5, area: '台灣海峽' };
    }

    // 生成 400-600 個隨機藍色圓點（50%深綠色外框，50%紅色外框）
    const dotCount = 400 + Math.floor(Math.random() * 201);
    console.log(`🔵 生成 ${dotCount} 個海域監測點`);
    
    // 計算邊框顏色分配
    const greenBorderCount = Math.floor(dotCount * 0.5); // 50% 深綠色
    const redBorderCount = dotCount - greenBorderCount;  // 50% 紅色
    
    // 建立邊框顏色陣列
    const dotColors = [];
    for (let i = 0; i < greenBorderCount; i++) {
        dotColors.push('#059669'); // 深綠色
    }
    for (let i = 0; i < redBorderCount; i++) {
        dotColors.push('#ef4444'); // 紅色
    }
    
    // 隨機打亂邊框顏色順序
    for (let i = dotColors.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [dotColors[i], dotColors[j]] = [dotColors[j], dotColors[i]];
    }
    
    for (let i = 1; i <= dotCount; i++) {
        const coord = generateSeaCoordinate();
        const dotId = `SD-${String(i).padStart(3, '0')}`;
        const dotColor = dotColors[i - 1];
        const status = window.seaDotManager.getStatusFromColor(dotColor);

        // 創建帶有指定邊框顏色的圓點（使用 canonical wrapper）
        const samplePoint = {
            pointId: dotId,
            id: dotId,
            lat: coord.lat,
            lon: coord.lon,
            timestamp: new Date().toISOString(),
            type: 'Normal',
            display: {
                backgroundColor: (typeof getBackgroundColor === 'function') ? getBackgroundColor({ display: { backgroundColor: dotColor } }) || dotColor : dotColor,
                dotColor: (typeof getDotColor === 'function') ? getDotColor({ display: { dotColor } }) || dotColor : dotColor,
                borderRadius: '50%',
                status: status
            }
        };
        const marker = (window.seaDotManager && typeof window.seaDotManager.createSeaDotFromPoint === 'function') ? window.seaDotManager.createSeaDotFromPoint(samplePoint) : window.seaDotManager.createSeaDot(coord.lat, coord.lon, dotId, status, 'Normal');
        marker.addTo(taiwanMap);
    }
    //clear
    //seaDotManager.clearAllDots();
    console.log(`✅ 海域監測點生成完成，共 ${window.seaDotManager.getDotsCount()} 個`);
    console.log(`📊 監測點分配: ${greenBorderCount} 個深綠色外框 (${(greenBorderCount/dotCount*100).toFixed(1)}%), ${redBorderCount} 個紅色外框 (${(redBorderCount/dotCount*100).toFixed(1)}%)`);
    // 在 sea dots 生成完成後，重新初始化 RF 和 Vessel 事件
    eventStorage.reinitializeRFEvents();
    eventStorage.reinitializeVesselEvents('vessel-003', '16.797148°N, 115.850213°E');
    eventStorage.reinitializeVesselEvents('vessel-004', '11.583010°N, 111.252487°E');
}

// 清理範例任務卡片
function clearExampleMissions() {
    const missionTimeline = document.querySelector('.mission-list');
    if (missionTimeline) {
        // 清除所有現有的任務卡片
        missionTimeline.innerHTML = '';
        console.log('✅ 已清理任務列表中的範例任務卡片');
    }
}

// 為已存在的船舶事件生成任務卡片
function generateMissionsForExistingVessels() {
    console.log('🚀 開始為已存在的船舶事件生成任務卡片...');

    // 獲取所有船舶事件
    const allEvents = eventStorage.getAllEvents();
    allEvents.forEach(eventData => {
        if (eventData.type === 'vessel' && eventData.trackPoints && eventData.trackPoints.length > 0) {
            console.log(`📍 為船舶事件 ${eventData.id} 生成任務卡片...`);

            // 為該船舶的軌跡點生成任務卡片
            eventStorage.generateMissionCardsFromTrackPoints(eventData.trackPoints, eventData.id);
        }
    });

    console.log('✅ 已完成為所有船舶事件生成任務卡片');
}

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    // ✅ 最先重新初始化區域事件的監控時間
    eventStorage.reinitializeAreaEvents();

    // 清理任務列表中的範例任務卡片，準備生成真實任務
    clearExampleMissions();

    // ✅ 加入這行 - 初始化地圖
    setTimeout(initializeTaiwanMap, 500);

    // 延遲為已存在的船舶事件生成任務卡片（等待軌跡點生成完成）
    setTimeout(() => {
        generateMissionsForExistingVessels();
    }, 1000);

    // 不再預設選中任何事件，讓使用者手動選擇

    // 模擬實時任務進度更新
    setInterval(() => {
        const progressBars = document.querySelectorAll('.mission-card .progress-fill');
        progressBars.forEach(bar => {
            const currentWidth = parseFloat(bar.style.width) || 0;
            if (currentWidth < 100 && (bar.closest('.mission-card').querySelector('.mission-status').textContent === '執行任務' || bar.closest('.mission-card').querySelector('.mission-status').textContent === '抵達')) {
                const newWidth = Math.min(100, currentWidth + Math.random() * 5);
                bar.style.width = newWidth + '%';
                
                const progressText = bar.parentElement.nextElementSibling;
                progressText.textContent = `進度: ${Math.round(newWidth)}%`;
            }
        });
    }, 5000);
    
    // 模擬實時狀態更新
    setInterval(() => {
        const timestamp = new Date().toLocaleTimeString('zh-TW', {hour12: false});
        const overlayInfo = document.querySelector('.overlay-info');
        if (overlayInfo && overlayInfo.textContent.includes('最後更新')) {
            const currentText = overlayInfo.innerHTML;
            overlayInfo.innerHTML = currentText.replace(/最後更新: \d{2}:\d{2}:\d{2}/, `最後更新: ${timestamp}`);
        }
    }, 30000);
});

// 縮放重置功能
function resetMapZoom() {
    if (taiwanMap) {
        // 清除調查範圍顯示
        clearInvestigationRange();
        
        // 回復到預設的台灣中心座標和縮放層級
        const defaultCenter = [23.8, 121.0];
        const defaultZoom = 7;
        
        // 平滑動畫回復到預設視圖
        taiwanMap.setView(defaultCenter, defaultZoom, {
            animate: true,
            duration: 1.5,
            easeLinearity: 0.25
        });
        
        console.log('🎯 地圖已重置到預設大小');
        
        // 顯示地圖調整訊息
        showMapAdjustmentMessage('地圖已重置到預設大小');
    }
}

// 船舶圖片測試資料庫
const shipPictureDatabase = [
    {
        id: 'SHIP-001',
        name: '漁船阿勇號',
        type: '漁船',
        mmsi: '416123456',
        image: './test-database-ship-picture/R.jpg',
        description: '台灣籍漁船，從事近海漁業作業'
    },
    {
        id: 'SHIP-002', 
        name: '貨輪海天號',
        type: '貨輪',
        mmsi: '416234567',
        image: './test-database-ship-picture/EYNKapcXsAA11xH.jpg',
        description: '國際貨運船舶，載運集裝箱'
    },
    {
        id: 'SHIP-003',
        name: '巡邏艇守護者',
        type: '巡邏艇',
        mmsi: '416345678',
        image: './test-database-ship-picture/nordkapp-class-opv-ramsund-2019.jpg',
        description: '海巡署巡邏船，執行海域巡護任務'
    },
    {
        id: 'SHIP-004',
        name: '研究船探索號',
        type: '研究船',
        mmsi: '416456789',
        image: './test-database-ship-picture/batral-brest-2018.jpg',
        description: '海洋研究船，進行科學調查'
    },
    {
        id: 'SHIP-005',
        name: '油輪星光號',
        type: '油輪',
        mmsi: '416567890',
        image: './test-database-ship-picture/castle-class-corvette-chattogram-2017.jpg',
        description: '石油運輸船，載運原油或成品油'
    }
];

// 顯示船舶圖片
function showShipPicture() {
    // 選擇特定船舶 (選擇第一艘 - 漁船阿勇號)
    const selectedShip = shipPictureDatabase[0];
    
    // 創建船舶圖片覆蓋層
    const shipOverlay = document.createElement('div');
    shipOverlay.id = 'shipPictureOverlay';
    shipOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        opacity: 0;
        transition: opacity 0.3s ease;
    `;
    
    // 創建船舶圖片容器
    const shipContainer = document.createElement('div');
    shipContainer.style.cssText = `
        background: white;
        border-radius: 12px;
        padding: 20px;
        max-width: 500px;
        max-height: 90%;
        text-align: center;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
        transform: scale(0.8);
        transition: transform 0.3s ease;
    `;
    
    // 創建標題
    const title = document.createElement('h3');
    title.textContent = '🚢 目標船舶影像';
    title.style.cssText = `
        margin: 0 0 15px 0;
        color: #1e40af;
        font-size: 18px;
    `;
    
    // 創建船舶圖片
    const shipImage = document.createElement('img');
    shipImage.src = selectedShip.image;
    shipImage.alt = selectedShip.name;
    shipImage.style.cssText = `
        width: 100%;
        max-width: 400px;
        height: 250px;
        object-fit: cover;
        border-radius: 8px;
        margin-bottom: 15px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    `;
    
    // 錯誤處理 - 如果圖片載入失敗，顯示預設的船舶 SVG
    shipImage.onerror = () => {
        const fallbackContainer = document.createElement('div');
        fallbackContainer.style.cssText = `
            width: 100%;
            max-width: 400px;
            height: 250px;
            background: linear-gradient(to bottom, #87ceeb 0%, #4682b4 100%);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 15px;
        `;
        
        fallbackContainer.innerHTML = `
            <svg width="200" height="120" viewBox="0 0 200 120" style="filter: drop-shadow(2px 2px 4px rgba(0,0,0,0.3));">
                <ellipse cx="100" cy="80" rx="90" ry="25" fill="#2d3748"/>
                <rect x="60" y="50" width="80" height="30" rx="5" fill="#4a5568"/>
                <rect x="85" y="35" width="8" height="20" fill="#e53e3e"/>
                <rect x="105" y="35" width="8" height="20" fill="#e53e3e"/>
                <circle cx="100" cy="40" r="3" fill="#38b2ac"/>
                <path d="M 10 80 Q 30 60 50 75 L 50 85 Q 30 100 10 80" fill="#1a202c"/>
        `;
        
        shipImage.parentNode.replaceChild(fallbackContainer, shipImage);
    };
    
    // 創建資訊文字
    const infoText = document.createElement('p');
    infoText.innerHTML = `
        <strong>船舶識別:</strong> ${selectedShip.mmsi}<br>
        <strong>船舶名稱:</strong> ${selectedShip.name}<br>
        <strong>船舶類型:</strong> ${selectedShip.type}<br>
        <strong>拍攝時間:</strong> ${new Date().toLocaleString('zh-TW')}<br>
        <strong>拍攝來源:</strong> 衛星/無人機<br>
        <strong>描述:</strong> ${selectedShip.description}
    `;
    infoText.style.cssText = `
        color: #4a5568;
        font-size: 14px;
        line-height: 1.6;
        margin: 15px 0;
        text-align: left;
        background: #f7fafc;
        padding: 12px;
        border-radius: 6px;
        border-left: 4px solid #3182ce;
    `;
    
    // 創建關閉按鈕
    const closeButton = document.createElement('button');
    closeButton.textContent = '關閉';
    closeButton.style.cssText = `
        background: #3182ce;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.2s ease;
        margin-top: 15px;
    `;
    
    closeButton.onmouseover = () => closeButton.style.background = '#2c5282';
    closeButton.onmouseout = () => closeButton.style.background = '#3182ce';
    
    closeButton.onclick = () => {
        shipOverlay.style.opacity = '0';
        shipContainer.style.transform = 'scale(0.8)';
        setTimeout(() => {
            if (shipOverlay.parentNode) {
                shipOverlay.parentNode.removeChild(shipOverlay);
            }
        }, 300);
    };
    
    // 組裝元素
    shipContainer.appendChild(title);
    shipContainer.appendChild(shipImage);
    shipContainer.appendChild(infoText);
    shipContainer.appendChild(closeButton);
    shipOverlay.appendChild(shipContainer);
    
    // 添加到頁面
    document.body.appendChild(shipOverlay);
    
    // 動畫顯示
    setTimeout(() => {
        shipOverlay.style.opacity = '1';
        shipContainer.style.transform = 'scale(1)';
    }, 50);
    
    // 點擊背景關閉
    shipOverlay.onclick = (e) => {
        if (e.target === shipOverlay) {
            closeButton.click();
        }
    };
    
    console.log(`🚢 船舶圖片已顯示: ${selectedShip.name} (${selectedShip.type})`);
}

// AIS狀態一致性管理函數
function ensureAISStatusConsistency(eventData) {
    if (!eventData || eventData.type !== 'rf') {
        return eventData;
    }
    
    // 如果已經有AIS狀態，不改變
    if (eventData.aisStatus) {
        console.log(`🔵 事件 ${eventData.id || 'RF事件'} 已有AIS狀態: ${eventData.aisStatus}`);
        return eventData;
    }
    
    // 嘗試從sourceSeaDot推導AIS狀態
    if (eventData.sourceSeaDot) {
        const resolvedColor = (typeof getDotColor === 'function') ? getDotColor(eventData.sourceSeaDot) : (eventData.sourceSeaDot && eventData.sourceSeaDot.dotColor) || null;
        if (resolvedColor === '#ef4444' || resolvedColor === 'red') {
            eventData.aisStatus = '未開啟';
        } else if (resolvedColor === '#059669' || resolvedColor === 'green') {
            eventData.aisStatus = '已開啟';
        } else {
            eventData.aisStatus = '未知';
        }
        console.log(`🔵 從sourceSeaDot推導事件 ${eventData.id || 'RF事件'} AIS狀態: ${eventData.aisStatus}`);
    } else {
        // 如果沒有sourceSeaDot，嘗試從seaDotManager查找
        if (eventData.rfId && typeof window.seaDotManager !== 'undefined') {
            const dot = window.seaDotManager.getDotByRFId(eventData.rfId);
            if (dot) {
                const resolvedColor = (typeof getDotColor === 'function') ? getDotColor(dot) : (dot && dot.dotColor) || null;
                if (resolvedColor === '#ef4444' || resolvedColor === 'red') {
                    eventData.aisStatus = '未開啟';
                } else if (resolvedColor === '#059669' || resolvedColor === 'green') {
                    eventData.aisStatus = '已開啟';
                } else {
                    eventData.aisStatus = '未知';
                }
                // 同時補充sourceSeaDot資訊
                eventData.sourceSeaDot = {
                    id: getSafePointId(dot),
                    status: dot.status,
                    dotColor: getDotColor(dot),
                    area: dot.area,
                    lat: dot.lat,
                    lon: dot.lon,
                    display: {
                        dotColor: getDotColor(dot),
                        backgroundColor: (typeof getBackgroundColor === 'function') ? getBackgroundColor(dot) : (dot.backgroundColor || getDotColor(dot))
                    }
                };
                console.log(`🔵 從seaDotManager推導事件 ${eventData.id || 'RF事件'} AIS狀態: ${eventData.aisStatus}`);
            } else {
                eventData.aisStatus = '未知';
                console.log(`🔵 無法找到對應的seaDot，設定事件 ${eventData.id || 'RF事件'} AIS狀態: ${eventData.aisStatus}`);
            }
        } else {
            eventData.aisStatus = '未知';
            console.log(`🔵 缺少必要資訊，設定事件 ${eventData.id || 'RF事件'} AIS狀態: ${eventData.aisStatus}`);
        }
    }
    
    // 保存更新到eventStorage
    if (eventData.id && eventStorage) {
        eventStorage.updateEvent(eventData.id, {
            aisStatus: eventData.aisStatus,
            sourceSeaDot: eventData.sourceSeaDot
        });
    }

    return eventData;
}

// 切换到船只追踪模式
function switchToTrackingMode(vesselId) {
    timelineMode = 'vessel';
    currentTrackingVessel = vesselId;

    // 改变布局
    const missionSection = document.querySelector('.mission-section');
    if (missionSection) {
        missionSection.classList.add('tracking-mode');
    }

    // 更新時間軸標題和添加返回按鈕
    const timelineHeader = document.querySelector('.mission-right .mission-header');
    if (timelineHeader) {
        timelineHeader.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between;">
                <div class="mission-title">🚢 ${vesselId.toUpperCase()} 軌跡歷史</div>
                <button onclick="switchToGlobalMode()" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">返回</button>
            </div>
            <div class="mission-filter">歷史軌跡 | 任務記錄</div>
        `;
    }

    // 生成船只轨迹时间轴
    generateVesselTimeline(vesselId);
}

// 切换回全局模式
function switchToGlobalMode() {
    timelineMode = 'global';
    currentTrackingVessel = null;

    // 恢复布局
    const missionSection = document.querySelector('.mission-section');
    if (missionSection) {
        missionSection.classList.remove('tracking-mode');
    }

    // 恢复时间轴标题
    const timelineHeader = document.querySelector('.mission-right .mission-header');
    if (timelineHeader) {
        timelineHeader.innerHTML = `
            <div class="mission-title">🕰️ 时间轴</div>
            <div class="mission-filter">今日 | 本週 | 所有</div>
        `;
    }

    // 恢复原有时间轴
    restoreGlobalTimeline();
}

// 生成船只轨迹时间轴
function generateVesselTimeline(vesselId) {
    const eventData = eventStorage.getEvent(vesselId);
    if (!eventData || !eventData.trackPoints) {
        console.warn('沒有找到船隻軌跡資料');
        return;
    }

    const timelineContainer = document.querySelector('.timeline-container');
    if (!timelineContainer) return;

    // 清空现有时间轴
    timelineContainer.innerHTML = '<div class="timeline-line"></div>';

    // 按时间排序轨迹点
    const sortedPoints = [...eventData.trackPoints].sort((a, b) =>
        new Date(a.timestamp) - new Date(b.timestamp)
    );

    const currentTime = new Date();

    sortedPoints.forEach((point, index) => {
        const timelineItem = document.createElement('div');
        timelineItem.className = 'timeline-item';

        const pointTime = new Date(point.timestamp);
        const isPast = pointTime < currentTime;

        // 格式化時間顯示
        const time = pointTime.toLocaleTimeString('zh-TW', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit'
        });

        // 根據是否有任務和時間狀態顯示不同內容
        const hasTask = point.hasTask || false;
        let taskInfo, taskStatus, dotClass;

        if (hasTask) {
            if (isPast) {
                taskInfo = point.taskInfo || '執行任務';
                taskStatus = '已完成';
                dotClass = 'timeline-dot-completed';
            } else {
                taskInfo = point.taskInfo || '執行任務';
                taskStatus = '已排程';
                dotClass = 'timeline-dot-scheduled';
            }
        } else {
            taskInfo = '正常航行';
            taskStatus = isPast ? '已通過' : '預計通過';
            dotClass = 'timeline-dot';
        }

        timelineItem.innerHTML = `
            <div class="timeline-time">${time}</div>
            <div class="${dotClass}"></div>
            <div class="timeline-content">
                <div class="timeline-title">📍 ${point.lat.toFixed(3)}°N, ${point.lon.toFixed(3)}°E</div>
                <div class="timeline-desc">${taskInfo}</div>
            </div>
        `;

        // 添加點擊事件
        timelineItem.style.cursor = 'pointer';
        timelineItem.addEventListener('click', () => {
            showTrackPointDetails(point, taskStatus, getVesselIdString(point));
        });

        timelineContainer.appendChild(timelineItem);
    });
}

// 顯示軌跡點詳細資訊
function showTrackPointDetails(point, taskStatus, vesselId) {
    // 創建彈出視窗
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'block';
    modal.id = 'trackPointModal';

    // defensive: ensure point exists and derive a safe vessel id string
    const safePoint = point || {};
    const pointTime = new Date(safePoint.timestamp);
    const formattedTime = isNaN(pointTime.getTime()) ? '未知時間' : pointTime.toLocaleString('zh-TW');
    const hasTask = safePoint.hasTask || false;
    const vesselIdStr = (vesselId || getVesselIdString(safePoint) || 'UNKNOWN').toString().toUpperCase();

    // 首先檢查是否有相關的派遣任務（移到外面以便全局訪問）
    const linkedMissions = hasTask ? missionTrackManager.getLinkedMissions(getSafePointId(point)) : [];

    // 處理任務資訊變數（用於備用顯示）
    let taskType = '', taskDescription = '';
    let fallbackTaskStatus = '';
    if (hasTask && linkedMissions.length === 0) {
        // 沒有相關派遣任務時，使用隨機邏輯
        const random = Math.random();
        if (random > 0.8) {
            taskType = '衛星重拍';
            taskDescription = '獲取該位置的最新衛星影像';
        } else if (random > 0.6) {
            taskType = 'UAV派遣';
            taskDescription = '派遣無人機進行近距離偵察';
        } else if (random > 0.4) {
            taskType = '聯繫船隻';
            taskDescription = '嘗試與船隻建立通訊聯繫';
        } else {
            taskType = '持續追蹤';
            taskDescription = '執行船隻位置監控和行為分析';
        }
        fallbackTaskStatus = Math.random() > 0.7 ? '已完成' : '執行中';
    }

    modal.innerHTML = `
        <div class="modal-content mission-details-content">
            <div class="modal-header">
                <div class="modal-title">🚢 ${vesselIdStr} 軌跡點詳情</div>
                <button class="close-btn" onclick="closeTrackPointModal()">&times;</button>
            </div>

            ${linkedMissions.length > 0 ? `
                <div class="mission-basic-info">
                    <div class="mission-overview">
                        <div class="mission-status">
                            <span class="status-label">狀態：</span>
                            <span class="mission-status-badge ${linkedMissions[0].status === 'completed' ? 'status-completed' : linkedMissions[0].status === 'scheduled' ? 'status-scheduled' : 'status-dispatched'}">${linkedMissions[0].status}</span>
                        </div>

                        <div class="mission-target">
                            <span class="target-label">目標：</span>
                            <span class="target-value">${linkedMissions[0].target || 'N/A'}</span>
                        </div>

                        <div class="mission-progress">
                            <span class="progress-label">進度：</span>
                            <div class="progress-bar-container">
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${linkedMissions[0].progress || 0}%"></div>
                                </div>
                                <span class="progress-percentage">${linkedMissions[0].progress || 0}%</span>
                            </div>
                        </div>
                    </div>

                    <div class="mission-timing">
                        <div class="time-info">
                            <div class="time-item">
                                <span class="time-label">⏰ 建立時間：</span>
                                <span class="time-value">${linkedMissions[0].startTime ? new Date(linkedMissions[0].startTime).toLocaleString('zh-TW') : 'N/A'}</span>
                            </div>

                            ${linkedMissions[0].scheduledTime ? `
                                <div class="time-item">
                                    <span class="time-label">📅 預定執行：</span>
                                    <span class="time-value scheduled-time">${new Date(linkedMissions[0].scheduledTime).toLocaleString('zh-TW')}</span>
                                </div>
                            ` : ''}

                            <div class="time-item">
                                <span class="time-label">⏳ 預計完成：</span>
                                <span class="time-value">${linkedMissions[0].estimatedCompletion || '計算中'}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="mission-description">
                    <h4>📋 任務描述</h4>
                    <div class="description-content">
                        ${linkedMissions[0].description || '標準' + linkedMissions[0].type + '任務，監控目標' + (linkedMissions[0].target || '') + '的活動狀況。'}
                    </div>
                </div>
            ` : ''}

            <div class="track-point-details">
                <div class="location-info">
                    <h4>📍 位置資訊</h4>
                    <div class="detail-row">
                        <span>座標:</span>
                        <span>${point.lat.toFixed(6)}°N, ${point.lon.toFixed(6)}°E</span>
                    </div>
                    <div class="detail-row">
                        <span>時間:</span>
                        <span>${formattedTime}</span>
                    </div>
                    <div class="detail-row">
                        <span>航行狀態:</span>
                        <span>${hasTask ? '執行任務中' : '正常航行'}</span>
                    </div>
                    <div class="detail-row">
                        <span>🇹🇼 距台灣:</span>
                        <span>${calculateDistanceToTaiwan(point.lat, point.lon).toFixed(1)}km</span>
                    </div>
                    ${point.threatLevel ? `
                    <div class="detail-row">
                        <span>⚠️ 威脅等級:</span>
                        <span>${point.threatLevel.symbol} ${point.threatLevel.name}</span>
                    </div>
                    ` : ''}
                </div>

                ${point.speed ? `
                <div class="vessel-status-info">
                    <h4>🚢 船舶狀態</h4>
                    <div class="detail-row">
                        <span>航行速度:</span>
                        <span>${point.speed.toFixed(1)} 節</span>
                    </div>
                    ${point.course ? `
                    <div class="detail-row">
                        <span>航向:</span>
                        <span>${point.course.toFixed(0)}°</span>
                    </div>
                    ` : ''}
                    ${point.signalStrength ? `
                    <div class="detail-row">
                        <span>信號強度:</span>
                        <span>${point.signalStrength.toFixed(1)} dBm</span>
                    </div>
                    ` : ''}
                    ${point.deviationFromRoute ? `
                    <div class="detail-row">
                        <span>偏離航線:</span>
                        <span>${point.deviationFromRoute.toFixed(1)}km</span>
                    </div>
                    ` : ''}
                </div>
                ` : ''}

                ${!linkedMissions.length && hasTask ? `
                    <div class="task-info-section">
                        <h4>📋 任務資訊</h4>
                        <div class="task-detail-row">
                            <span>任務類型:</span>
                            <span>${taskType || '監控任務'}</span>
                        </div>
                        <div class="task-detail-row">
                            <span>狀態:</span>
                            <span class="task-status-${(fallbackTaskStatus || taskStatus) === '已完成' ? 'completed' : 'scheduled'}">${fallbackTaskStatus || taskStatus || '執行中'}</span>
                        </div>
                        <div class="task-detail-row">
                            <span>說明:</span>
                            <span>${taskDescription || '執行船舶監控和行為分析'}</span>
                        </div>
                    </div>
                ` : ''}

                ${!hasTask ? '<div class="no-task-info">📍 此位置點無特殊任務</div>' : ''}
            </div>

            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="closeTrackPointModal()">關閉</button>
                ${linkedMissions.length > 0 ? `<button class="btn btn-primary" onclick="showMissionDetails('${linkedMissions[0].missionId}')">查看任務詳情</button>` : ''}
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

// 關閉軌跡點詳情彈窗
function closeTrackPointModal() {
    const modal = document.getElementById('trackPointModal');
    if (modal) {
        modal.remove();
    }
}

// 恢复全局时间轴
function restoreGlobalTimeline() {
    const timelineContainer = document.querySelector('.timeline-container');
    if (!timelineContainer) return;

    // 重新生成默认时间轴
    timelineContainer.innerHTML = `
        <div class="timeline-line"></div>
        <div class="timeline-item">
            <div class="timeline-time">14:25</div>
            <div class="timeline-dot"></div>
            <div class="timeline-content">
                <div class="timeline-title">🚁 MMSI-416789012</div>
                <div class="timeline-desc">完成</div>
            </div>
        </div>
        <div class="timeline-item">
            <div class="timeline-time">15:30</div>
            <div class="timeline-dot"></div>
            <div class="timeline-content">
                <div class="timeline-title">🛰️ 衛星重拍</div>
                <div class="timeline-desc">抵達</div>
            </div>
        </div>
        <div class="timeline-item">
            <div class="timeline-time">16:30</div>
            <div class="timeline-dot"></div>
            <div class="timeline-content">
                <div class="timeline-title">🚁 MMSI-416123456</div>
                <div class="timeline-desc">執行中</div>
            </div>
        </div>
    `;
}

// 新增：添加时间轴事件
function addTimelineEvent(status, title, description, missionId) {
    const timelineContainer = document.querySelector('.timeline-container');
    if (!timelineContainer) return; // 检查是否存在

    const currentTime = new Date().toLocaleTimeString('zh-TW', {hour12: false, hour: '2-digit', minute: '2-digit'});

    // 创建新时间轴项
    const newItem = document.createElement('div');
    newItem.className = 'timeline-item';
    newItem.setAttribute('data-mission-id', missionId);
    newItem.style.cursor = 'pointer';
    newItem.innerHTML = `
        <div class="timeline-time">${currentTime}</div>
        <div class="timeline-dot"></div>
        <div class="timeline-content">
            <div class="timeline-title">${title}</div>
            <div class="timeline-desc">${status}</div>
        </div>
    `;

    // 添加点击事件 - 高亮对应任务卡
    newItem.addEventListener('click', () => {
        highlightMissionCard(missionId);
    });

    // 添加到最右侧（最新）
    timelineContainer.appendChild(newItem);

    // 滚动到最新事件
    const timeline = document.querySelector('.mission-timeline');
    if (timeline) {
        timeline.scrollLeft = timeline.scrollWidth;
    }
}

// 获取当前选中事件的目标信息
function getTargetInfo() {
    const currentEvent = eventStorage.getEvent(currentEventId);
    if (!currentEvent) return 'N/A';

    switch (currentEvent.type) {
        case 'vessel':
            // 船舶事件：使用MMSI
            return currentEvent.mmsi || 'MMSI-N/A';
        case 'rf':
            // RF事件：使用RF ID
            return currentEvent.rfId || 'RF-N/A';
        case 'area':
            // 区域事件：使用区域名称
            return currentEvent.aoiName || '区域-N/A';
        default:
            return currentEventId.toUpperCase();
    }
}

// 高亮任务卡并同步高亮时间轴
function highlightMissionCard(missionId) {
    // 清除所有高亮
    document.querySelectorAll('.mission-card').forEach(card => {
        card.classList.remove('highlighted');
    });
    document.querySelectorAll('.timeline-item').forEach(item => {
        item.classList.remove('highlighted');
    });

    // 高亮选中的任务卡
    const missionCard = document.querySelector(`[data-mission-id="${missionId}"]`);
    if (missionCard) {
        missionCard.classList.add('highlighted');
        // 滚动到视野内
        missionCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    // 高亮对应时间轴项
    const timelineItem = document.querySelector(`.timeline-item[data-mission-id="${missionId}"]`);
    if (timelineItem) {
        timelineItem.classList.add('highlighted');
        // 滚动到视野内
        timelineItem.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
}

// 顯示已完成任務 (歷史軌跡點) - 包含威脅評估
function showCompletedTasksForPoint(point, vesselId) {
    const completedTasks = getCompletedTasksForPoint(point, vesselId);
    const vesselEvent = eventStorage.getEvent(vesselId);
    const vesselHistory = vesselEvent && vesselEvent.trackPoints ? vesselEvent.trackPoints : [];

    if (typeof showTaskModalWithThreat === 'function') {
        showTaskModalWithThreat(point, vesselId, completedTasks, '已完成任務', 'completed', vesselHistory);
    } else {
        showTaskModal(point, vesselId, completedTasks, '已完成任務', 'completed');
    }
}

// 顯示已排程任務 (未來軌跡點) - 包含威脅評估
function showScheduledTasksForPoint(point, vesselId) {
    const scheduledTasks = getScheduledTasksForPoint(point, vesselId);
    const vesselEvent = eventStorage.getEvent(vesselId);
    const vesselHistory = vesselEvent && vesselEvent.trackPoints ? vesselEvent.trackPoints : [];

    if (typeof showTaskModalWithThreat === 'function') {
        showTaskModalWithThreat(point, vesselId, scheduledTasks, '已排程任務', 'scheduled', vesselHistory);
    } else {
        showTaskModal(point, vesselId, scheduledTasks, '已排程任務', 'scheduled');
    }
}

// 統一的任務模態框顯示（包含AIS訊號狀態）
function showTaskModal(point, vesselId, tasks, taskTypeTitle, taskStatus) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'block';
    modal.id = 'trackPointTaskModal';

    const pointTime = new Date(point.timestamp);
    const formattedTime = pointTime.toLocaleString('zh-TW');

    // 檢查AIS訊號狀態
    const isAbnormal = checkSignalAbnormality(point);
    const aisStatus = isAbnormal ? '異常' : '正常';
    const aisStatusClass = isAbnormal ? 'ais-abnormal' : 'ais-normal';

    const tasksHtml = tasks.length > 0
        ? tasks.map(task => `
            <div class="task-item ${taskStatus}">
                <div class="task-header">
                    <span class="task-icon">${task.icon}</span>
                    <span class="task-type">${task.type}</span>
                    <span class="task-status-badge status-${taskStatus}">${taskStatus === 'completed' ? '已完成' : '已排程'}</span>
                </div>
                <div class="task-description">${task.description}</div>
                <div class="task-time">${taskStatus === 'completed' ? '完成時間' : '預計執行'}: ${task.time}</div>
            </div>
        `).join('')
        : `<div class="no-tasks">此軌跡點${taskStatus === 'completed' ? '尚無已完成' : '暫無已排程'}任務</div>`;

    modal.innerHTML = `
        <div class="modal-content task-modal">
            <div class="modal-header">
                <div class="modal-title">🚢 ${vesselId.toUpperCase()} - ${taskTypeTitle}</div>
                <button class="close-btn" onclick="closeTaskModal()">&times;</button>
            </div>

            <div class="point-info">
                <div class="point-location">📍 ${point.lat.toFixed(6)}°N, ${point.lon.toFixed(6)}°E</div>
                <div class="point-time">🕐 ${formattedTime}</div>
                <div class="ais-status">
                    <span class="ais-label">📡 AIS訊號狀態:</span>
                    <span class="ais-value ${aisStatusClass}">${aisStatus}</span>
                </div>
                ${isAbnormal ? `
                    <div class="signal-details">
                        <div class="signal-item">速度: ${point.speed ? point.speed.toFixed(1) : 'N/A'} 節</div>
                        <div class="signal-item">信號強度: ${point.signalStrength ? point.signalStrength.toFixed(1) : 'N/A'} dBm</div>
                        <div class="signal-item">航線偏離: ${point.deviationFromRoute ? point.deviationFromRoute.toFixed(1) : 'N/A'} 公里</div>
                    </div>
                ` : ''}
            </div>

            <div class="tasks-container">
                <h4>${taskTypeTitle}</h4>
                ${tasksHtml}
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

// 關閉任務模態框
function closeTaskModal() {
    const modal = document.getElementById('trackPointTaskModal');
    if (modal) {
        modal.remove();
    }
}

// 檢查訊號異常狀態（全局函數版本）
function checkSignalAbnormality(trackPointData) {
    // 1. 檢查是否有異常的速度變化
    if (trackPointData.speed && (trackPointData.speed > 25 || trackPointData.speed < 0.5)) {
        return true;
    }

    // 2. 檢查是否偏離航線過遠
    if (trackPointData.deviationFromRoute && trackPointData.deviationFromRoute > 5) {
        return true;
    }

    // 3. 檢查AIS信號強度
    if (trackPointData.signalStrength && trackPointData.signalStrength < -80) {
        return true;
    }

    // 4. 檢查是否在禁航區域
    if (trackPointData.inRestrictedZone) {
        return true;
    }

    return false;
}

// 獲取軌跡點的已完成任務
function getCompletedTasksForPoint(point, vesselId) {
    const tasks = [];

    if (point.hasTask) {
        // 檢查是否有相關的派遣任務
        const linkedMissions = missionTrackManager.getLinkedMissions(getSafePointId(point));

        if (linkedMissions.length > 0) {
            // 顯示相關派遣任務的資訊
            linkedMissions.forEach(mission => {
                if (mission.status === '已完成') {
                    // 將派遣任務類型映射到四個固定選項
                    let taskIcon, taskType, taskDescription;

                    switch (mission.type) {
                        case 'UAV 派遣':
                            taskIcon = '🚁';
                            taskType = 'UAV派遣';
                            taskDescription = `已完成無人機監控 - 目標: ${mission.target}`;
                            break;
                        case '衛星重拍':
                            taskIcon = '🛰️';
                            taskType = '衛星重拍';
                            taskDescription = `已獲取衛星影像 - 目標: ${mission.target}`;
                            break;
                        case '持續追蹤':
                            taskIcon = '🎯';
                            taskType = '持續追蹤';
                            taskDescription = `已完成船隻監控 - 目標: ${mission.target}`;
                            break;
                        case '聯繫船隻':
                            taskIcon = '📞';
                            taskType = '聯繫船隻';
                            taskDescription = `已完成通訊嘗試 - 目標: ${mission.target}`;
                            break;
                        default:
                            taskIcon = '🎯';
                            taskType = '持續追蹤';
                            taskDescription = `已完成${mission.type} - 目標: ${mission.target}`;
                    }

                    tasks.push({
                        icon: taskIcon,
                        type: taskType,
                        description: taskDescription,
                        time: mission.completedTime ? new Date(mission.completedTime).toLocaleString('zh-TW') : new Date(mission.startTime).toLocaleString('zh-TW'),
                        missionId: mission.missionId
                    });
                }
            });
        }

        // 如果沒有相關派遣任務，則使用原有邏輯
        if (tasks.length === 0) {
            tasks.push({
                icon: '🎯',
                type: '持續追蹤',
                description: '已完成船隻位置監控和行為分析',
                time: new Date(point.timestamp).toLocaleString('zh-TW')
            });

            if (Math.random() > 0.7) {
                tasks.push({
                    icon: '🛰️',
                    type: '衛星重拍',
                    description: '已獲取該位置的最新衛星影像',
                    time: new Date(point.timestamp + 30 * 60 * 1000).toLocaleString('zh-TW')
                });
            }
        }
    }

    return tasks;
}

// 獲取軌跡點的已排程任務
function getScheduledTasksForPoint(point, vesselId) {
    const tasks = [];

    if (point.hasTask) {
        // 檢查是否有相關的派遣任務
        const linkedMissions = missionTrackManager.getLinkedMissions(getSafePointId(point));

        if (linkedMissions.length > 0) {
            // 顯示相關派遣任務的資訊
            linkedMissions.forEach(mission => {
                if (mission.status === '派遣' || mission.status === '執行任務') {
                    // 將派遣任務類型映射到四個固定選項
                    let taskIcon, taskType, taskDescription;

                    switch (mission.type) {
                        case 'UAV 派遣':
                            taskIcon = '🚁';
                            taskType = 'UAV派遣';
                            taskDescription = `預定無人機監控 - 目標: ${mission.target}`;
                            break;
                        case '衛星重拍':
                            taskIcon = '🛰️';
                            taskType = '衛星重拍';
                            taskDescription = `預定獲取衛星影像 - 目標: ${mission.target}`;
                            break;
                        case '持續追蹤':
                            taskIcon = '🎯';
                            taskType = '持續追蹤';
                            taskDescription = `預定監控船隻 - 目標: ${mission.target}`;
                            break;
                        case '聯繫船隻':
                            taskIcon = '📞';
                            taskType = '聯繫船隻';
                            taskDescription = `預定與船隻通訊 - 目標: ${mission.target}`;
                            break;
                        default:
                            taskIcon = '🎯';
                            taskType = '持續追蹤';
                            taskDescription = `預定執行${mission.type} - 目標: ${mission.target}`;
                    }

                    const statusText = mission.status === '派遣' ? '已排程' : '執行中';
                    tasks.push({
                        icon: taskIcon,
                        type: taskType,
                        description: `${statusText}: ${taskDescription}`,
                        time: mission.scheduledTime ? new Date(mission.scheduledTime).toLocaleString('zh-TW') : new Date(mission.startTime).toLocaleString('zh-TW'),
                        missionId: mission.missionId
                    });
                }
            });
        }

        // 如果沒有相關派遣任務，則使用原有邏輯
        if (tasks.length === 0) {
            tasks.push({
                icon: '🎯',
                type: '預定追蹤',
                description: '將在船隻抵達此位置時進行監控',
                time: new Date(point.timestamp).toLocaleString('zh-TW')
            });

            if (Math.random() > 0.6) {
                tasks.push({
                    icon: '🚁',
                    type: 'UAV派遣',
                    description: '派遣無人機進行近距離偵察',
                    time: new Date(point.timestamp + 60 * 60 * 1000).toLocaleString('zh-TW')
                });
            }
        }
    }

    return tasks;
}
// 顯示派遣任務詳情（包含相關軌跡點資訊）
function showMissionDetails(missionId) {
    console.log('Showing mission details for:', missionId);

    // 從統一管理器獲取任務資訊和相關軌跡點
    const mission = missionTrackManager.missions.get(missionId);
    const linkedTrackPoints = missionTrackManager.getLinkedTrackPoints(missionId);

    console.log('Mission data:', mission);
    console.log('Linked track points:', linkedTrackPoints);

    if (!mission) {
        console.warn('Mission not found:', missionId);
        alert('任務資訊不存在');
        return;
    }

    // 創建任務詳情模態框
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'block';
    modal.id = 'missionDetailsModal';

    const formattedStartTime = new Date(mission.startTime).toLocaleString('zh-TW');
    const formattedScheduledTime = mission.scheduledTime ? new Date(mission.scheduledTime).toLocaleString('zh-TW') : null;

    // 判斷任務狀態和顯示顏色
    const statusClass = mission.status === '已完成' ? 'status-completed' :
                       mission.status === '執行任務' ? 'status-executing' :
                       mission.status === '派遣' ? 'status-dispatched' : 'status-scheduled';

    // 生成相關軌跡點的HTML
    const trackPointsHtml = linkedTrackPoints.length > 0
        ? linkedTrackPoints.map(point => {
            const pointTime = new Date(point.timestamp).toLocaleString('zh-TW');
            const pointType = point.type === 'History' ? '歷史' : point.type === 'Future' ? '預測' : '當前';
            const threatLevel = point.threatLevel ? `${point.threatLevel.symbol} ${point.threatLevel.name}` : '未評估';
            const distance = point.lat && point.lon ? calculateDistanceToTaiwan(point.lat, point.lon).toFixed(1) : 'N/A';

            return `
                <div class="linked-track-point" onclick="highlightTrackPoint('${point.pointId}')">
                    <div class="track-point-header">
                        <span class="track-point-type">${pointType}點</span>
                        <span class="track-point-time">${pointTime}</span>
                    </div>
                    <div class="track-point-location">
                        📍 ${point.lat ? point.lat.toFixed(6) : 'N/A'}°N, ${point.lon ? point.lon.toFixed(6) : 'N/A'}°E
                    </div>
                    <div class="track-point-threat">
                        ⚠️ 威脅等級: ${threatLevel} | 🇹🇼 距台灣: ${distance}km
                    </div>
                </div>
            `;
        }).join('')
        : '<div class="no-track-points">此任務暫無關聯的軌跡點</div>';

    modal.innerHTML = `
        <div class="modal-content mission-details-content">
            <div class="modal-header">
                <div class="modal-title">🚢 ${mission.type} - ${missionId}</div>
                <button class="close-btn" onclick="closeMissionDetailsModal()">&times;</button>
            </div>

            <div class="mission-basic-info">
                <div class="mission-overview">
                    <div class="mission-status">
                        <span class="status-label">狀態：</span>
                        <span class="mission-status-badge ${statusClass}">${mission.status}</span>
                    </div>

                    <div class="mission-target">
                        <span class="target-label">目標：</span>
                        <span class="target-value">${mission.target || 'N/A'}</span>
                    </div>

                    <div class="mission-progress">
                        <span class="progress-label">進度：</span>
                        <div class="progress-bar-container">
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${mission.progress || 0}%"></div>
                            </div>
                            <span class="progress-percentage">${mission.progress || 0}%</span>
                        </div>
                    </div>
                </div>

                <div class="mission-timing">
                    <div class="time-info">
                        <div class="time-item">
                            <span class="time-label">⏰ 建立時間：</span>
                            <span class="time-value">${formattedStartTime}</span>
                        </div>

                        ${formattedScheduledTime ? `
                            <div class="time-item">
                                <span class="time-label">📅 預定執行：</span>
                                <span class="time-value scheduled-time">${formattedScheduledTime}</span>
                            </div>
                        ` : ''}

                        <div class="time-item">
                            <span class="time-label">⏳ 預計完成：</span>
                            <span class="time-value">${mission.estimatedCompletion || '計算中'}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="mission-description">
                <h4>📋 任務描述</h4>
                <div class="description-content">
                    ${mission.description || '標準' + mission.type + '任務，監控目標' + (mission.target || '') + '的活動狀況。'}
                </div>
            </div>

            <div class="linked-track-points-section">
                <h4>🎯 相關軌跡點 (${linkedTrackPoints.length})</h4>
                <div class="track-points-container">
                    ${trackPointsHtml}
                </div>
            </div>

            <div class="mission-actions">
                <button class="btn btn-secondary" onclick="closeMissionDetailsModal()">關閉</button>
                ${mission.status !== '已完成' ? '<button class="btn btn-primary" onclick="updateMissionStatus(\'' + missionId + '\')">更新狀態</button>' : ''}
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

// 關閉任務詳情模態框
function closeMissionDetailsModal() {
    const modal = document.getElementById('missionDetailsModal');
    if (modal) {
        modal.remove();
    }
}

// 高亮軌跡點（當從任務詳情點擊軌跡點時）
function highlightTrackPoint(pointId) {
    console.log('Highlighting track point:', pointId);

    // 在地圖上高亮對應的軌跡點
    if (window.taiwanMap && window.vesselMarkers) {
        Object.keys(vesselMarkers).forEach(vesselId => {
            const vesselData = vesselMarkers[vesselId];
            if (vesselData.trackPoints) {
                vesselData.trackPoints.forEach(point => {
                    if (point.pointId === pointId && point.marker) {
                        // 暫時放大標記以示高亮
                        const originalIcon = point.marker.getIcon();
                        point.marker.setIcon(L.divIcon({
                            ...originalIcon.options,
                            html: originalIcon.options.html.replace('font-size: 16px', 'font-size: 24px'),
                            className: originalIcon.options.className + ' highlighted-track-point'
                        }));

                        // 3秒後恢復原狀
                        setTimeout(() => {
                            if (point.marker) {
                                point.marker.setIcon(originalIcon);
                            }
                        }, 3000);

                        // 地圖移動到該點
                        taiwanMap.setView([point.lat, point.lon], Math.max(taiwanMap.getZoom(), 10));
                    }
                });
            }
        });
    }
}

// 更新任務狀態
function updateMissionStatus(missionId) {
    const mission = missionTrackManager.missions.get(missionId);
    if (mission) {
        // 簡單的狀態循環邏輯
        const statusCycle = ['派遣', '執行任務', '已完成'];
        const currentIndex = statusCycle.indexOf(mission.status);
        const nextIndex = (currentIndex + 1) % statusCycle.length;

        mission.status = statusCycle[nextIndex];
        mission.progress = mission.status === '已完成' ? 100 :
                          mission.status === '執行任務' ? Math.min(90, (mission.progress || 0) + 30) :
                          mission.progress || 15;

        console.log(`Updated mission ${missionId} status to: ${mission.status}, progress: ${mission.progress}%`);

        // 刷新任務詳情顯示
        closeMissionDetailsModal();
        showMissionDetails(missionId);

        // 更新任務卡片顯示
        updateMissionCardDisplay(missionId, mission);
    }
}

// 更新任務卡片顯示
function updateMissionCardDisplay(missionId, mission) {
    const missionCard = document.querySelector(`[data-mission-id="${missionId}"]`);
    if (missionCard) {
        const statusBadge = missionCard.querySelector('.mission-status');
        const progressFill = missionCard.querySelector('.progress-fill');
        const progressText = missionCard.querySelector('.progress-text');

        if (statusBadge) {
            statusBadge.textContent = mission.status;
            statusBadge.className = `mission-status ${mission.status === '已完成' ? 'status-completed' :
                                                     mission.status === '執行任務' ? 'status-executing' :
                                                     mission.status === '派遣' ? 'status-dispatched' : 'status-scheduled'}`;
        }

        if (progressFill) {
            progressFill.style.width = `${mission.progress}%`;
        }

        if (progressText) {
            progressText.textContent = mission.status === '已完成' ? '已完成 | 任務結束' :
                                     `進度: ${mission.progress}% | ${mission.estimatedCompletion || '計算中'}`;
        }
    }
}

// === 決策建議收合展開功能 ===
function toggleDecisionRecommendation() {
    const content = document.getElementById('decision-recommendation-content');
    const icon = document.getElementById('decision-collapse-icon');
    
    if (!content || !icon) {
        console.warn('決策建議收合元素未找到');
        return;
    }
    
    if (content.classList.contains('collapsed')) {
        // 展開
        content.classList.remove('collapsed');
        content.classList.add('expanded');
        icon.textContent = '▲';
    } else {
        // 收合
        content.classList.remove('expanded');
        content.classList.add('collapsed');
        icon.textContent = '▼';
    }
}

// 保障性：在 DOMContentLoaded 時再次嘗試 attach（避免載入順序造成的 race）
document.addEventListener('DOMContentLoaded', () => {
    if (window.__attachSeaDotManager && !window.seaDotManager) {
        const ok = window.__attachSeaDotManager();
        if (ok) console.log('SeaDotManager attached on DOMContentLoaded fallback');
    }
});

// === 清除地圖上除歷史軌跡點外的所有信號點功能 ===

// 全域變數用於儲存被清除的信號點資料
let hiddenSignalPoints = {
    seaDots: new Map(),           // 儲存被清除的 SeaDotManager 點
    vesselMarkers: {},            // 儲存被清除的船舶標記
    investigationRange: null,     // 儲存被清除的調查範圍
    temporaryMarkers: [],         // 儲存被清除的臨時標記
    clearTime: null,              // 清除時間戳
    isCleared: false              // 是否有被清除的點
};

/**
 * 安全檢查地圖實例並獲取有效的地圖對象
 * @returns {Object|null} 有效的地圖實例或null
 */
function getValidMapInstance() {
    // 首先檢查全局的 taiwanMap 變量
    if (typeof taiwanMap !== 'undefined' && taiwanMap && typeof taiwanMap.hasLayer === 'function') {
        return taiwanMap;
    }
    // 檢查 window.taiwanMap
    if (window.taiwanMap && typeof window.taiwanMap.hasLayer === 'function') {
        return window.taiwanMap;
    }
    // 都沒有找到有效的地圖實例
    return null;
}

/**
 * 清除地圖上除歷史軌跡點外的所有信號點
 * 此功能會保留歷史軌跡點(History type)，移除其他所有類型的點
 * 包括：RF信號點、當前位置點、未來預測點、普通監測點等
 */
function clearNonTrackPoints() {
    console.log('🧹 開始清除地圖上除歷史軌跡點外的所有信號點...');
    
    let removedCount = 0;
    let preservedHistoryCount = 0;

    try {
        // 獲取有效的地圖實例
        const mapInstance = getValidMapInstance();
        if (!mapInstance) {
            console.warn('⚠️ 未找到有效的地圖實例，無法執行清除操作');
            if (typeof showUserMessage === 'function') {
                showUserMessage('地圖未初始化，無法執行清除操作', 'warning');
            }
            return {
                removed: 0,
                preserved: 0,
                success: false,
                error: '地圖未初始化'
            };
        }

        // 1. 清除 SeaDotManager 管理的所有RF信號點和監測點
        if (window.seaDotManager && typeof window.seaDotManager.seaDots !== 'undefined') {
            console.log('📍 清除 SeaDotManager 中的信號點...');
            
            // 遍歷所有 SeaDotManager 管理的點，並儲存它們
            const allDots = Array.from(window.seaDotManager.seaDots.values());
            allDots.forEach(dotData => {
                // 儲存被清除的點資料
                hiddenSignalPoints.seaDots.set(dotData.id, {
                    ...dotData,
                    wasOnMap: dotData.marker && mapInstance.hasLayer(dotData.marker)
                });
                
                // SeaDotManager 管理的都不是歷史軌跡點，全部清除
                if (dotData.marker && mapInstance.hasLayer(dotData.marker)) {
                    mapInstance.removeLayer(dotData.marker);
                    removedCount++;
                }
            });
            
            // 清空 SeaDotManager 的數據
            window.seaDotManager.seaDots.clear();
            window.seaDotManager.dotIdCounter = 1;
            console.log(`✅ 已清除並儲存 ${allDots.length} 個 SeaDotManager 管理的信號點`);
        }

        // 2. 跳過對歷史軌跡圖層的處理
        // currentHistoryLayers 中的點是通過 displayHistoryTrack 函數創建的船舶軌跡點
        if (window.currentHistoryLayers && Array.isArray(window.currentHistoryLayers)) {
            console.log(`🗺️ 跳過歷史軌跡圖層處理 (包含 ${window.currentHistoryLayers.length} 個軌跡點)`);
            console.log('這些點被認為是歷史軌跡點，將被保留');
            preservedHistoryCount += window.currentHistoryLayers.length;
        } else if (typeof currentHistoryLayers !== 'undefined' && Array.isArray(currentHistoryLayers)) {
            console.log(`🗺️ 跳過局部歷史軌跡圖層處理 (包含 ${currentHistoryLayers.length} 個軌跡點)`);
            console.log('這些點被認為是歷史軌跡點，將被保留');
            preservedHistoryCount += currentHistoryLayers.length;
        }

        // 3. 只移除明確的非軌跡船舶標記
        if (window.vesselMarkers && typeof window.vesselMarkers === 'object') {
            console.log('🚢 處理獨立船舶標記...');

            Object.keys(window.vesselMarkers).forEach(vesselId => {
                const vesselData = window.vesselMarkers[vesselId];
                
                // 只移除主要船舶標記（非歷史軌跡類型）
                if (vesselData.marker && mapInstance.hasLayer(vesselData.marker)) {
                    // 檢查是否是歷史軌跡標記
                    if (!vesselData.isHistoryMarker && !vesselData.isTrackMarker) {
                        mapInstance.removeLayer(vesselData.marker);
                        removedCount++;
                        console.log(`移除獨立船舶標記: ${vesselId}`);
                    } else {
                        preservedHistoryCount++;
                        console.log(`保留船舶軌跡標記: ${vesselId}`);
                    }
                }
                
                // 完全跳過軌跡點的處理
                if (vesselData.trackPoints && Array.isArray(vesselData.trackPoints)) {
                    preservedHistoryCount += vesselData.trackPoints.length;
                    console.log(`保留船舶 ${vesselId} 的 ${vesselData.trackPoints.length} 個軌跡點`);
                }
            });
        }

        console.log(`🎉 清除完成！總共移除 ${removedCount} 個非歷史軌跡點，保留 ${preservedHistoryCount} 個歷史軌跡點`);
        
        // 更新隱藏狀態
        if (removedCount > 0) {
            hiddenSignalPoints.clearTime = new Date().toISOString();
            hiddenSignalPoints.isCleared = true;
            console.log('📦 已儲存被清除的信號點資料，可使用 restoreHiddenSignalPoints() 恢復');
        }
        
        return {
            removed: removedCount,
            preserved: preservedHistoryCount,
            success: true
        };

    } catch (error) {
        console.error('❌ 清除地圖點時發生錯誤:', error);
        return {
            removed: removedCount,
            preserved: preservedHistoryCount,
            success: false,
            error: error.message
        };
    }
}

// 將函數暴露到全域範圍，方便在控制台或其他地方調用
window.clearNonTrackPoints = clearNonTrackPoints;

/**
 * 恢復被 clearNonTrackPoints 隱藏的所有信號點
 * 這個功能會重新顯示之前被清除的RF信號點和其他非歷史軌跡點
 */
function restoreHiddenSignalPoints() {
    console.log('🔄 開始恢復被隱藏的信號點...');
    
    let restoredCount = 0;
    
    try {
        // 檢查是否有被隱藏的點
        if (!hiddenSignalPoints.isCleared) {
            console.log('ℹ️ 沒有找到被隱藏的信號點');
            return {
                restored: 0,
                success: true,
                message: '沒有被隱藏的點需要恢復'
            };
        }

        // 獲取有效的地圖實例
        const mapInstance = getValidMapInstance();
        if (!mapInstance) {
            console.warn('⚠️ 未找到有效的地圖實例，無法執行恢復操作');
            if (typeof showUserMessage === 'function') {
                showUserMessage('地圖未初始化，無法執行恢復操作', 'warning');
            }
            return {
                restored: 0,
                success: false,
                error: '地圖未初始化'
            };
        }

        // 1. 恢復 SeaDotManager 管理的信號點
        if (hiddenSignalPoints.seaDots.size > 0) {
            console.log('📍 恢復 SeaDotManager 中的信號點...');
            
            // 確保 SeaDotManager 存在
            if (!window.seaDotManager) {
                console.warn('⚠️ SeaDotManager 不存在，無法恢復信號點');
            } else {
                hiddenSignalPoints.seaDots.forEach((dotData, dotId) => {
                    try {
                        // 恢復點到 SeaDotManager
                        window.seaDotManager.seaDots.set(dotId, dotData);
                        
                        // 如果點之前在地圖上，重新創建並添加到地圖
                        if (dotData.wasOnMap) {
                            // 重新創建標記
                            const newMarker = window.seaDotManager.createMarker(dotData);
                            dotData.marker = newMarker;
                            
                            // 添加到地圖
                            if (newMarker && mapInstance) {
                                newMarker.addTo(mapInstance);
                                restoredCount++;
                                console.log(`恢復信號點: ${dotId}`);
                            }
                        }
                    } catch (error) {
                        console.warn(`恢復信號點 ${dotId} 時發生錯誤:`, error);
                    }
                });
                
                console.log(`✅ 已恢復 ${hiddenSignalPoints.seaDots.size} 個 SeaDotManager 管理的信號點`);
            }
        }

        // 2. 恢復船舶標記
        if (Object.keys(hiddenSignalPoints.vesselMarkers).length > 0) {
            console.log('🚢 恢復船舶標記...');
            
            Object.keys(hiddenSignalPoints.vesselMarkers).forEach(vesselId => {
                const hiddenVesselData = hiddenSignalPoints.vesselMarkers[vesselId];
                
                // 恢復到 window.vesselMarkers
                if (window.vesselMarkers) {
                    window.vesselMarkers[vesselId] = hiddenVesselData;
                    
                    // 如果有標記且之前在地圖上，重新添加
                    if (hiddenVesselData.marker && hiddenVesselData.wasOnMap) {
                        try {
                            hiddenVesselData.marker.addTo(mapInstance);
                            restoredCount++;
                            console.log(`恢復船舶標記: ${vesselId}`);
                        } catch (error) {
                            console.warn(`恢復船舶標記 ${vesselId} 時發生錯誤:`, error);
                        }
                    }
                }
            });
            
            console.log(`✅ 已恢復 ${Object.keys(hiddenSignalPoints.vesselMarkers).length} 個船舶標記`);
        }

        // 3. 恢復調查範圍標記
        if (hiddenSignalPoints.investigationRange) {
            console.log('📐 恢復調查範圍標記...');
            
            try {
                window.investigationRangeLayer = hiddenSignalPoints.investigationRange;
                if (hiddenSignalPoints.investigationRange.addTo) {
                    hiddenSignalPoints.investigationRange.addTo(mapInstance);
                    restoredCount++;
                }
            } catch (error) {
                console.warn('恢復調查範圍標記時發生錯誤:', error);
            }
        }

        // 清除隱藏狀態
        hiddenSignalPoints = {
            seaDots: new Map(),
            vesselMarkers: {},
            investigationRange: null,
            temporaryMarkers: [],
            clearTime: null,
            isCleared: false
        };

        console.log(`🎉 恢復完成！總共恢復 ${restoredCount} 個信號點`);
        
        return {
            restored: restoredCount,
            success: true
        };

    } catch (error) {
        console.error('❌ 恢復信號點時發生錯誤:', error);
        return {
            restored: restoredCount,
            success: false,
            error: error.message
        };
    }
}

/**
 * 檢查當前是否有被隱藏的信號點
 * @returns {Object} 包含隱藏狀態資訊的物件
 */
function getHiddenSignalPointsStatus() {
    return {
        isCleared: hiddenSignalPoints.isCleared,
        clearTime: hiddenSignalPoints.clearTime,
        hiddenCount: {
            seaDots: hiddenSignalPoints.seaDots.size,
            vesselMarkers: Object.keys(hiddenSignalPoints.vesselMarkers).length,
            investigationRange: hiddenSignalPoints.investigationRange ? 1 : 0,
            temporaryMarkers: hiddenSignalPoints.temporaryMarkers.length,
            total: hiddenSignalPoints.seaDots.size + 
                   Object.keys(hiddenSignalPoints.vesselMarkers).length + 
                   (hiddenSignalPoints.investigationRange ? 1 : 0) + 
                   hiddenSignalPoints.temporaryMarkers.length
        }
    };
}

// 將新函數暴露到全域範圍
window.restoreHiddenSignalPoints = restoreHiddenSignalPoints;
window.getHiddenSignalPointsStatus = getHiddenSignalPointsStatus;