// EventDataStorage extracted from script.js
(function(){
  class EventDataStorage {
    constructor() {
      this.events = new Map();
      this.initializeDefaultEvents();
    }

    // 初始化預設事件資料
    initializeDefaultEvents() {
      // 為 area-001 事件生成基本區域資訊
      const areaRange = window.generateRandomSeaAreaRange ? window.generateRandomSeaAreaRange() : { latRange: [21.9,25.3], lonRange: [120.0,122.0] };
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
      });

      // 初始化 RF 事件，等待 SeaDotManager 可用後再填入具體資訊
      let rfEventData = {
        id: 'rf-002',
        type: 'rf',
        detectionTime: '13:45',
        createTime: '13:45',
        status: 'analyzed',
        notes: '未知信號源，無 AIS 對應',
        rfId: 'SIG-4A7B2C',
        frequency: '162.025 MHz',
        strength: '-47 dBm',
        coordinates: window.generateSeaCoordinateForEvents ? window.generateSeaCoordinateForEvents() : {lat:24.0,lon:119.5}
      };

      this.events.set('rf-002', rfEventData);

      this.events.set('vessel-003', {
        id: 'vessel-003',
        type: 'vessel',
        mmsi: '416123456',
        coordinates: '等待初始化...',
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
        coordinates: '等待初始化...',
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

      const existingRfEvent = this.events.get('rf-002');
      if (existingRfEvent) {
        const allDots = window.seaDotManager.getAllDots();
        const randomDot = allDots[Math.floor(Math.random() * allDots.length)];
        let aisStatus = '未知';
        // prefer canonical-safe helper for color resolution
        const randomDotColor = (typeof getDotColor === 'function') ? getDotColor(randomDot) : (randomDot.dotColor || null);
        if (randomDotColor === '#ef4444' || randomDotColor === 'red') {
          aisStatus = '未開啟';
        } else if (randomDotColor === '#059669' || randomDotColor === 'green') {
          aisStatus = '已開啟';
        }

        const updatedEventData = {
          ...existingRfEvent,
          rfId: randomDot.rfId,
          coordinates: `${randomDot.lat.toFixed(3)}°N, ${randomDot.lon.toFixed(3)}°E`,
          frequency: '162.025 MHz',
          strength: '-47 dBm',
          aisStatus: aisStatus,
            sourceSeaDot: {
            id: randomDot.id,
            status: randomDot.status,
            dotColor: (typeof getDotColor === 'function') ? (getDotColor(randomDot) || randomDot.dotColor) : (randomDotColor || randomDot.dotColor),
            area: randomDot.area,
            // canonical display subobject for consumers that prefer display-first shape
              display: {
              dotColor: (typeof getDotColor === 'function') ? (getDotColor(randomDot) || randomDot.dotColor) : (randomDotColor || randomDot.dotColor),
              backgroundColor: (typeof getBackgroundColor === 'function' ? getBackgroundColor(randomDot) : (randomDot.backgroundColor || randomDot.dotColor)) || (randomDotColor || randomDot.dotColor)
            }
          }
        };

        this.events.set('rf-002', updatedEventData);
        console.log(`✅ RF 事件 rf-002 已重新初始化，使用 sea dot ${randomDot.id}，RF ID: ${randomDot.rfId}，AIS 狀態: ${aisStatus}`);
        this.updateEventCardDisplay('rf-002', updatedEventData);
      }
    }

    // 重新初始化 Vessel 事件（在 SeaDotManager 可用後調用）
    reinitializeVesselEvents() {
      if (typeof window.seaDotManager === 'undefined' || window.seaDotManager.getAllDots().length === 0) {
        console.warn('⚠️ SeaDotManager 仍不可用，跳過 Vessel 事件重新初始化');
        return;
      }

      const existingVesselEvent = this.events.get('vessel-003');
      if (existingVesselEvent) {
        const allDots = window.seaDotManager.getAllDots();
        const randomDot = allDots[Math.floor(Math.random() * allDots.length)];
        let aisStatus = '未知';
        const randomDotColor = (typeof getDotColor === 'function') ? getDotColor(randomDot) : (randomDot.dotColor || null);
        if (randomDotColor === '#ef4444' || randomDotColor === 'red') {
          aisStatus = '未開啟';
        } else if (randomDotColor === '#059669' || randomDotColor === 'green') {
          aisStatus = '已開啟';
        }

        let riskScore = existingVesselEvent.riskScore || 85;
        let investigationReason = existingVesselEvent.investigationReason || 'AIS 異常關閉，偏離正常航道';
        if (randomDotColor === '#ef4444' || randomDotColor === 'red') {
          riskScore = Math.floor(Math.random() * 20) + 80;
          investigationReason = 'AIS 信號異常關閉，船舶行為可疑';
        } else if (randomDotColor === '#059669' || randomDotColor === 'green') {
          riskScore = Math.floor(Math.random() * 30) + 60;
          investigationReason = '定期監控，船舶位置異常';
        }

        const updatedEventData = {
          ...existingVesselEvent,
          coordinates: `${randomDot.lat.toFixed(3)}°N, ${randomDot.lon.toFixed(3)}°E`,
          riskScore: riskScore,
          investigationReason: investigationReason,
          aisStatus: aisStatus,
          sourceSeaDot: {
            id: randomDot.id,
            status: randomDot.status,
            dotColor: randomDotColor || randomDot.dotColor,
            area: randomDot.area,
            // canonical display for consumers
            display: {
              dotColor: randomDotColor || randomDot.dotColor,
              backgroundColor: (typeof getBackgroundColor === 'function' ? getBackgroundColor(randomDot) : (randomDot.backgroundColor || randomDot.dotColor)) || (randomDotColor || randomDot.dotColor)
            }
          }
        };

        if (existingVesselEvent.id === 'vessel-003') {
          updatedEventData.trackPoints = existingVesselEvent.trackPoints;
          console.log(`🔄 為船舶事件 vessel-003 保留了預設的 'cargo' 軌跡點`);
        } else if (!existingVesselEvent.trackPoints || existingVesselEvent.trackPoints.length === 0) {
          updatedEventData.trackPoints = this.generateFixedTrackPoints(existingVesselEvent.id, randomDot.lat, randomDot.lon);
          console.log(`✅ 為重新初始化的船舶事件 ${existingVesselEvent.id} 生成了新的固定軌跡點`);
        } else {
          updatedEventData.trackPoints = existingVesselEvent.trackPoints;
          console.log(`🔄 為重新初始化的船舶事件 ${existingVesselEvent.id} 保留了現有的軌跡點`);
        }

        this.events.set('vessel-003', updatedEventData);
        console.log(`✅ Vessel 事件 vessel-003 已重新初始化，使用 sea dot ${randomDot.id}，風險分數: ${riskScore}，AIS 狀態: ${aisStatus}，座標: ${updatedEventData.coordinates}`);
        this.updateEventCardDisplay('vessel-003', updatedEventData);
      }
    }

    // 重新初始化 Area 事件（更新監控時間為當前時間）
    reinitializeAreaEvents() {
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
  const totalHistoryPoints = 8;
  const totalFuturePoints = 4;
  const distance = 0.015;
  const currentTime = new Date();
  const threeHoursMs = 3 * 60 * 60 * 1000; // use 3-hour granularity

      let trackPoints = [];
      let previousPoint = { lat: endLat, lon: endLon };

      for (let i = 0; i < totalHistoryPoints; i++) {
        const angleAwayFromTarget = Math.atan2(previousPoint.lat - endLat, previousPoint.lon - endLon);
        const randomAngleOffset = (Math.random() - 0.5) * (Math.PI / 3);
        const finalAngle = angleAwayFromTarget + randomAngleOffset;

        const newLat = previousPoint.lat + distance * Math.sin(finalAngle);
        const newLon = previousPoint.lon + distance * Math.cos(finalAngle);

  const timestamp = new Date(currentTime.getTime() - (totalHistoryPoints - i) * threeHoursMs);

        const trackPoint = {
          id: `${eventId}_history_${i}`,
          lat: newLat,
          lon: newLon,
          status: Math.random() < 0.7 ? 'AIS' : 'No AIS',
          type: 'History',
          timestamp: timestamp.toISOString(),
          speed: 8 + Math.random() * 12,
          signalStrength: -45 - Math.random() * 25,
          deviationFromRoute: Math.random() * 3,
          inRestrictedZone: Math.random() > 0.95,
          hasTask: Math.random() > 0.6,
          taskType: Math.random() > 0.6 ? ['監控任務', '追蹤任務'][Math.floor(Math.random() * 2)] : null,
          taskDescription: Math.random() > 0.6 ? '執行船舶監控和行為分析' : null,
          vesselId: eventId
        };

        // normalize to canonical point (keep legacy aliases)
        const canonicalHistory = (typeof createCanonicalPoint === 'function') ? createCanonicalPoint(trackPoint, { legacy: true }) : (function(){ trackPoint.id = trackPoint.id || trackPoint.pointId; trackPoint.trackPointData = Object.assign({}, trackPoint); return trackPoint; })();
        if (window.missionTrackManager) {
          window.missionTrackManager.createTrackPoint(canonicalHistory);
        }
        trackPoints.unshift(canonicalHistory);
        previousPoint = { lat: newLat, lon: newLon };
      }

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

      // normalize current point
      const canonicalCurrent = (typeof createCanonicalPoint === 'function') ? createCanonicalPoint(currentPoint, { legacy: true }) : (function(){ currentPoint.id = currentPoint.id || currentPoint.pointId; currentPoint.trackPointData = Object.assign({}, currentPoint); return currentPoint; })();
      if (window.missionTrackManager) {
        window.missionTrackManager.createTrackPoint(canonicalCurrent);
      }
      trackPoints.push(canonicalCurrent);

      previousPoint = { lat: endLat, lon: endLon };
      for (let i = 0; i < totalFuturePoints; i++) {
        const angleTowardsFuture = Math.random() * Math.PI * 2;
        const newLat = previousPoint.lat + distance * Math.sin(angleTowardsFuture);
        const newLon = previousPoint.lon + distance * Math.cos(angleTowardsFuture);
  const timestamp = new Date(currentTime.getTime() + (i + 1) * threeHoursMs);
        const willBeAbnormal = Math.random() < 0.3;

        const rawPoint = {
          id: `${eventId}_future_${i}`,
          lat: newLat,
          lon: newLon,
          status: 'Predicted',
          type: 'Future',
          timestamp: timestamp.toISOString(),
          speed: willBeAbnormal ? (Math.random() > 0.5 ? 30 + Math.random() * 10 : Math.random() * 2) : (12 + Math.random() * 8),
          signalStrength: willBeAbnormal ? (-80 - Math.random() * 20) : (-55 - Math.random() * 15),
          deviationFromRoute: willBeAbnormal ? (5 + Math.random() * 5) : (Math.random() * 2),
          inRestrictedZone: willBeAbnormal && Math.random() > 0.7,
          hasTask: Math.random() > 0.4,
          taskType: Math.random() > 0.4 ? ['預定追蹤', '巡查任務', '異常調查'][Math.floor(Math.random() * 3)] : null,
          taskDescription: Math.random() > 0.4 ? (willBeAbnormal ? '預計處理異常訊號事件' : '預計執行監控和追蹤任務') : null,
          vesselId: eventId
        };

        // normalize to canonical point (keep legacy aliases)
        const trackPoint = (typeof createCanonicalPoint === 'function') ? createCanonicalPoint(rawPoint, { legacy: true }) : (function(){ rawPoint.id = rawPoint.id || rawPoint.pointId; rawPoint.trackPointData = Object.assign({}, rawPoint); return rawPoint; })();

        if (window.missionTrackManager) {
          window.missionTrackManager.createTrackPoint(trackPoint);
        }

        trackPoints.push(trackPoint);
        previousPoint = { lat: newLat, lon: newLon };
      }

      console.log(`✅ 為船舶事件 ${eventId} 生成了完整的軌跡點 (歷史:${totalHistoryPoints}, 當前:1, 未來:${totalFuturePoints})`);
      this.generateMissionCardsFromTrackPoints(trackPoints, eventId);
      return trackPoints;
    }

    // 為軌跡點中的任務生成對應的任務卡片
    generateMissionCardsFromTrackPoints(trackPoints, eventId) {
      trackPoints.forEach(point => {
        if (point.hasTask && point.taskType) {
          let actionType, missionType, actionIcon;
          switch (point.taskType) {
            case '監控任務':
            case '追蹤任務':
            case '當前監控':
              actionType = 'track'; missionType = '持續追蹤'; actionIcon = '🎯'; break;
            case '預定追蹤':
              actionType = 'track'; missionType = '持續追蹤'; actionIcon = '🎯'; break;
            case '巡查任務':
              actionType = 'uav'; missionType = 'UAV 派遣'; actionIcon = '🚁'; break;
            case '異常調查':
              actionType = 'satellite'; missionType = '衛星重拍'; actionIcon = '🛰️'; break;
            default:
              actionType = 'track'; missionType = '持續追蹤'; actionIcon = '🎯';
          }

          let missionStatus, executionTime;
          const pointTime = new Date(point.timestamp);
          const currentTime = new Date();
          if (point.type === 'History') { missionStatus = '已完成'; executionTime = pointTime; }
          else if (point.type === 'Current') { missionStatus = '執行任務'; executionTime = pointTime; }
          else { missionStatus = '派遣'; executionTime = pointTime; }

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
            progress: point.type === 'History' ? 100 : point.type === 'Current' ? 75 : point.type === 'Future' ? 15 : 0,
            estimatedCompletion: point.type !== 'History' ? this.formatEstimatedCompletion(executionTime) : null,
            isScheduled: point.type === 'Future',
            // prefer passing a stable sourceTrackPointId (normalize via helper)
            sourceTrackPointId: (typeof getSafePointId === 'function') ? getSafePointId(point) : (point.id || point.pointId || null)
          };

          if (window.missionTrackManager) {
            const missionId = window.missionTrackManager.createMission(missionData);
            this.createMissionCard(missionId, missionData);
            console.log(`✅ 為軌跡點 ${point.id} 創建了對應的任務卡片: ${missionId} (${missionType})`);
          }
        }
      });
    }

    formatEstimatedCompletion(executionTime) {
      const estimatedEnd = new Date(executionTime.getTime() + 2 * 60 * 60 * 1000);
      return estimatedEnd.toLocaleString('zh-TW').split(' ')[1];
    }

    createMissionCard(missionId, missionData) {
      const missionTimeline = document.querySelector('.mission-list');
      if (!missionTimeline) { console.warn('找不到任務列表容器，無法添加軌跡點任務'); return; }

      const newMission = document.createElement('div');
      newMission.className = 'mission-card';
      newMission.setAttribute('data-mission-id', missionId);

      const statusClass = missionData.status === '已完成' ? 'status-completed' : missionData.status === '執行任務' ? 'status-executing' : missionData.status === '派遣' ? 'status-dispatched' : 'status-scheduled';
      const progressText = missionData.status === '已完成' ? '已完成 | 任務結束' : missionData.estimatedCompletion ? `進度: ${missionData.progress}% | 預計 ${missionData.estimatedCompletion} 完成` : `進度: ${missionData.progress}%`;

      newMission.innerHTML = `
            <div class="mission-card-header">
                <span class="mission-type">${missionData.actionIcon} ${missionData.type}</span>
                <span class="mission-status ${statusClass}">${missionData.status}</span>
            </div>
            <div class="mission-details">
                目標: ${missionData.target}<br>
                ${missionData.scheduledTime ? '排程: ' + new Date(missionData.scheduledTime).toLocaleString('zh-TW') : missionData.completedTime ? '完成: ' + new Date(missionData.completedTime).toLocaleString('zh-TW') : '開始: ' + new Date(missionData.startTime).toLocaleString('zh-TW')}
            </div>
            <div class="mission-progress">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${missionData.progress}%"></div>
                </div>
                <div class="progress-text">${progressText}</div>
            </div>
        `;

      newMission.addEventListener('click', () => { window.highlightMissionCard && window.highlightMissionCard(missionId); window.showMissionDetails && window.showMissionDetails(missionId); });
      newMission.style.cursor = 'pointer';
      missionTimeline.appendChild(newMission);
      this.updateMissionStats();
    }

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
      // ... keep original fixed arrays and behavior by delegating to window.generateSimulatedTrackPoints if exists
      if (window.generateSimulatedTrackPoints) return window.generateSimulatedTrackPoints(shiptype);
      return [];
    }
  }

  // expose a global instance
  window.eventStorage = new EventDataStorage();
})();
