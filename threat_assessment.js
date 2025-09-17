// ==================== 威脅評估系統 ====================

// 威脅等級定義（參考颱風路徑概念 - 以台灣為中心）
const THREAT_LEVELS = {
    LOW: {
        level: 1,
        name: '低威脅',
        color: '#10b981',
        direction: 'east',      // 東方外海 - 遠離台灣
        symbol: '🟢',
        description: '外海正常航行，距離台灣較遠'
    },
    MEDIUM: {
        level: 2,
        name: '中等威脅',
        color: '#eab308',
        direction: 'north',     // 北方海域 - 接近台海
        symbol: '🟡',
        description: '進入台海北部，需要持續監控'
    },
    HIGH: {
        level: 3,
        name: '高威脅',
        color: '#f97316',
        direction: 'south',     // 南方海域 - 接近台灣南部
        symbol: '🟠',
        description: '接近台灣南部海域，高風險區域'
    },
    CRITICAL: {
        level: 4,
        name: '極高威脅',
        color: '#dc2626',
        direction: 'west',      // 西方 - 直指台灣本島
        symbol: '🔴',
        description: '直指台灣本島方向，極度危險'
    }
};

// 威脅評估主函數
// Use canonical-safe helpers when available
const _getTrackPointData = (typeof window !== 'undefined' && window.safePointHelpers && window.safePointHelpers.getTrackPointData) ? window.safePointHelpers.getTrackPointData : (p => p || null);

// 威脅評估主函數
function assessThreatLevel(trackPointData, vesselHistory = []) {
    const tp = _getTrackPointData(trackPointData) || {};
    let threatScore = 0;
    let threatFactors = [];
    let aisLossCount = 0;

    // 1. AIS訊號狀態評估
    if (tp.signalStrength) {
        if (tp.signalStrength < -90) {
            threatScore += 30;
            threatFactors.push('AIS信號極弱');
        } else if (tp.signalStrength < -80) {
            threatScore += 20;
            threatFactors.push('AIS信號衰弱');
        }
    }

    // 2. AIS關閉且持續無訊號威脅提升機制
    if (tp.status === 'No AIS') {
        threatScore += 25;
        threatFactors.push('AIS訊號中斷');

        // 檢查歷史紀錄中連續無AIS的次數
        aisLossCount = countConsecutiveAISLoss(vesselHistory, tp);
        if (aisLossCount >= 3) {
            threatScore += 40;
            threatFactors.push(`連續${aisLossCount}次AIS中斷`);
        } else if (aisLossCount >= 2) {
            threatScore += 25;
            threatFactors.push(`連續${aisLossCount}次AIS中斷`);
        }
    }

    // 3. 速度異常評估
    if (tp.speed) {
        if (tp.speed > 35) {
            threatScore += 35;
            threatFactors.push('異常高速航行');
        } else if (tp.speed > 25) {
            threatScore += 20;
            threatFactors.push('超速航行');
        } else if (tp.speed < 0.5) {
            threatScore += 30;
            threatFactors.push('異常停留');
        }
    }

    // 4. 航線偏離評估
    if (tp.deviationFromRoute) {
        if (tp.deviationFromRoute > 10) {
            threatScore += 40;
            threatFactors.push('嚴重偏離航線');
        } else if (tp.deviationFromRoute > 5) {
            threatScore += 25;
            threatFactors.push('偏離預定航線');
        }
    }

    // 5. 禁航區域評估
    if (tp.inRestrictedZone) {
        threatScore += 50;
        threatFactors.push('進入禁航區域');
    }

    // 6. 時間因素（夜間活動增加威脅）
    const pointTime = new Date(tp.timestamp);
    const hour = pointTime.getHours();
    if (hour >= 22 || hour <= 5) {
        threatScore += 10;
        threatFactors.push('夜間活動');
    }

    // 7. 距離台灣遠近評估（核心威脅指標）
    const distanceToTaiwan = calculateDistanceToTaiwan(tp.lat, tp.lon);
    if (distanceToTaiwan <= 50) {
        threatScore += 60;
        threatFactors.push('極接近台灣本島（<50km）');
    } else if (distanceToTaiwan <= 100) {
        threatScore += 40;
        threatFactors.push('接近台灣海域（<100km）');
    } else if (distanceToTaiwan <= 200) {
        threatScore += 20;
        threatFactors.push('進入台海周邊（<200km）');
    } else if (distanceToTaiwan <= 300) {
        threatScore += 10;
        threatFactors.push('台海外圍區域（<300km）');
    }

    // 8. 未來預測點的不確定性
    if (tp.type === 'Future') {
        threatScore += 5;
        threatFactors.push('預測不確定性');
    }

    // 根據總分決定威脅等級（基於距離台灣的威脅評估）
    let threatLevel;
    if (threatScore >= 100) {
        threatLevel = THREAT_LEVELS.CRITICAL;  // 極高威脅：直指台灣本島
    } else if (threatScore >= 70) {
        threatLevel = THREAT_LEVELS.HIGH;      // 高威脅：接近台灣南部海域
    } else if (threatScore >= 40) {
        threatLevel = THREAT_LEVELS.MEDIUM;    // 中等威脅：進入台海北部
    } else {
        threatLevel = THREAT_LEVELS.LOW;       // 低威脅：東方外海
    }

    return {
        level: threatLevel,
        score: threatScore,
        factors: threatFactors,
        aisLossCount: aisLossCount,
        recommendation: generateThreatRecommendation(threatLevel, threatFactors)
    };
}

// 計算連續AIS訊號中斷次數
function countConsecutiveAISLoss(vesselHistory, currentPoint) {
    if (!vesselHistory || vesselHistory.length === 0) return 0;

    let count = 0;
    // 從最新的歷史點開始往回檢查
    for (let i = vesselHistory.length - 1; i >= 0; i--) {
        if (vesselHistory[i].status === 'No AIS') {
            count++;
        } else {
            break; // 遇到有AIS的點就停止計算
        }
    }

    // 加上當前點（如果也是No AIS）
    if (currentPoint.status === 'No AIS') {
        count++;
    }

    return count;
}

// 生成威脅評估建議
function generateThreatRecommendation(threatLevel, factors) {
    const recommendations = [];

    switch (threatLevel.level) {
        case 4: // CRITICAL
            recommendations.push('🚨 立即派遣巡邏艦艇前往調查');
            recommendations.push('📡 嘗試多頻道聯繫船隻');
            recommendations.push('🛰️ 啟動衛星密集監控');
            break;
        case 3: // HIGH
            recommendations.push('🚁 考慮派遣UAV進行監控');
            recommendations.push('📞 聯繫相關執法單位');
            recommendations.push('⏰ 增加監控頻率');
            break;
        case 2: // MEDIUM
            recommendations.push('👁️ 持續密切監控');
            recommendations.push('📋 記錄異常行為模式');
            recommendations.push('🔄 定期更新位置資訊');
            break;
        default: // LOW
            recommendations.push('📊 維持標準監控程序');
            recommendations.push('💾 記錄正常航行軌跡');
            break;
    }

    return recommendations;
}

// 創建威脅方向指示器（颱風路徑風格）
function createThreatDirectionIndicator(threatLevel, lat, lon) {
    const directionArrows = {
        north: '⬆️',    // 低威脅 - 遠離威脅
        east: '➡️',     // 中等威脅 - 監控中
        south: '⬇️',    // 高威脅 - 接近威脅
        west: '⬅️'      // 極高威脅 - 進入危險區域
    };

    const arrow = directionArrows[threatLevel.direction];

    return L.divIcon({
        html: `
            <div class="threat-direction-indicator" style="
                color: ${threatLevel.color};
                font-size: 20px;
                text-shadow: 0 0 4px rgba(0,0,0,0.8);
                transform: translateX(-50%) translateY(-100%);
                position: relative;
                z-index: 1000;
            ">
                ${arrow}
            </div>
        `,
        className: 'threat-direction-marker',
        iconSize: [24, 24],
        iconAnchor: [12, 24]
    });
}

// 更新軌跡點顯示威脅資訊
function updateTrackPointWithThreat(point, vesselHistory = []) {
    const threatAssessment = assessThreatLevel(point, vesselHistory);

    return {
        ...point,
        threatLevel: threatAssessment.level,
        threatScore: threatAssessment.score,
        threatFactors: threatAssessment.factors,
        threatRecommendation: threatAssessment.recommendation,
        aisLossCount: threatAssessment.aisLossCount
    };
}

// 整合威脅評估到任務模態框
function showTaskModalWithThreat(point, vesselId, tasks, taskTypeTitle, taskStatus, vesselHistory = []) {
    const threatAssessment = assessThreatLevel(point, vesselHistory);
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

                <div class="threat-assessment">
                    <div class="threat-level">
                        <span class="threat-label">⚠️ 威脅等級:</span>
                        <span class="threat-value threat-${threatAssessment.level.level}" style="color: ${threatAssessment.level.color}">
                            ${threatAssessment.level.symbol} ${threatAssessment.level.name} (${threatAssessment.score}分)
                        </span>
                    </div>
                    <div class="threat-direction">
                        <span class="direction-label">🧭 威脅方向:</span>
                        <span class="direction-indicator">${getThreatDirectionArrow(threatAssessment.level.direction)} ${getThreatDirectionText(threatAssessment.level.direction)}</span>
                    </div>
                </div>

                <div class="ais-status">
                    <span class="ais-label">📡 AIS訊號狀態:</span>
                    <span class="ais-value ${aisStatusClass}">${aisStatus}</span>
                    ${threatAssessment.aisLossCount > 0 ? `<span class="ais-loss-count">(連續中斷 ${threatAssessment.aisLossCount} 次)</span>` : ''}
                </div>

                <div class="distance-to-taiwan">
                    <span class="distance-label">🇹🇼 距離台灣:</span>
                    <span class="distance-value">${calculateDistanceToTaiwan(point.lat, point.lon).toFixed(1)} 公里</span>
                </div>

                ${threatAssessment.factors.length > 0 ? `
                    <div class="threat-factors">
                        <div class="factors-title">🚨 威脅因子:</div>
                        <ul class="factors-list">
                            ${threatAssessment.factors.map(factor => `<li>${factor}</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}

                ${isAbnormal ? `
                    <div class="signal-details">
                        <div class="signal-item">速度: ${point.speed ? point.speed.toFixed(1) : 'N/A'} 節</div>
                        <div class="signal-item">信號強度: ${point.signalStrength ? point.signalStrength.toFixed(1) : 'N/A'} dBm</div>
                        <div class="signal-item">航線偏離: ${point.deviationFromRoute ? point.deviationFromRoute.toFixed(1) : 'N/A'} 公里</div>
                    </div>
                ` : ''}

                <div class="threat-recommendations">
                    <div class="recommendations-title">📋 建議行動:</div>
                    <ul class="recommendations-list">
                        ${threatAssessment.recommendation.map(rec => `<li>${rec}</li>`).join('')}
                    </ul>
                </div>
            </div>

            <div class="tasks-container">
                <h4>${taskTypeTitle}</h4>
                ${tasksHtml}
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

// 輔助函數：獲取威脅方向箭頭
function getThreatDirectionArrow(direction) {
    const arrows = {
        north: '⬆️',
        east: '➡️',
        south: '⬇️',
        west: '⬅️'
    };
    return arrows[direction] || '❓';
}

// 輔助函數：獲取威脅方向文字說明
function getThreatDirectionText(direction) {
    const descriptions = {
        east: '東方外海 - 遠離台灣',
        north: '北方海域 - 接近台海',
        south: '南方海域 - 接近台灣南部',
        west: '西方 - 直指台灣本島'
    };
    return descriptions[direction] || '未知方向';
}

// 計算船舶位置距離台灣的距離（公里）
function calculateDistanceToTaiwan(lat, lon) {
    // 台灣中心點座標（約在台中附近）
    const TAIWAN_CENTER = { lat: 24.0, lon: 120.9 };

    // 使用Haversine公式計算距離
    const R = 6371; // 地球半徑（公里）
    const dLat = toRadians(lat - TAIWAN_CENTER.lat);
    const dLon = toRadians(lon - TAIWAN_CENTER.lon);

    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRadians(TAIWAN_CENTER.lat)) * Math.cos(toRadians(lat)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
}

// 將角度轉換為弧度
function toRadians(degrees) {
    return degrees * (Math.PI / 180);
}