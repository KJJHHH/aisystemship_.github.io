// Simulated track points generator extracted from script.js
(function(){
  // helper: normalize a raw point into a canonical point object
  function createCanonicalPoint(raw, opts = { legacy: true }) {
    const now = new Date();
    const pointId = raw.pointId || raw.id || `TRACK-${Date.now()}-${Math.random().toString(16).substr(2,6)}`;
    const timestamp = raw.timestamp || raw.time || now.toISOString();
    const type = raw.type || (raw.status === 'Predicted' ? 'Future' : (raw.type === 'Future' ? 'Future' : 'Normal'));
    const backgroundColor = raw.backgroundColor || raw.dotColor || (type === 'Future' ? '#FFD54A' : (raw.status === 'No AIS' ? '#ef4444' : '#10b981'));
    const dotColor = raw.dotColor || backgroundColor;
    const borderRadius = raw.borderRadius || (type === 'History' ? '2px' : '50%');

    const canonical = {
      pointId: pointId,
      id: pointId,
      lat: Number(raw.lat),
      lon: Number(raw.lon),
      timestamp: (new Date(timestamp)).toISOString(),
      type: type,
      vesselId: raw.vesselId || raw.vessel || null,
      display: {
        backgroundColor: backgroundColor,
        dotColor: dotColor,
        borderRadius: borderRadius,
        status: raw.status || 'unknown',
        rfId: raw.rfId || null
      },
      speed: raw.speed,
      signalStrength: raw.signalStrength,
      deviationFromRoute: raw.deviationFromRoute,
      inRestrictedZone: raw.inRestrictedZone,
      hasTask: raw.hasTask,
      taskType: raw.taskType,
      taskDescription: raw.taskDescription,
      boundMissionId: raw.boundMissionId || null
    };

    if (opts.legacy !== false) {
      // legacy top-level aliases
      canonical.backgroundColor = canonical.display.backgroundColor;
      canonical.dotColor = canonical.display.dotColor;
      canonical.borderRadius = canonical.display.borderRadius;
      // some consumers expect trackPointData to exist
      canonical.trackPointData = Object.assign({}, canonical);
    }

    return canonical;
  }

  // expose helper globally so other modules (EventDataStorage, MissionTrackManager) can reuse
  window.createCanonicalPoint = createCanonicalPoint;

  window.generateSimulatedTrackPoints = function(shiptype) {
    const tracks = {
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
        { lat: 13.021062791568709, lon: 112.751101670687994, status: 'AIS', type: 'Future' }
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
        { lat: 19.344809349959917, lon: 117.07381239505587, status: 'AIS', type: 'Future' }
      ]
    };

    const currentTime = new Date();
    let trackData = [];
    if (shiptype === 'fishing') trackData = tracks.fishing;
    else if (shiptype === 'cargo') trackData = tracks.cargo;

  return trackData.map((p, i) => {
      let timestamp;
      // Use 3-hour spacing as the minimal time unit for predefined tracks
      const threeHoursMs = 3 * 60 * 60 * 1000;
      if (p.type === 'History') {
        timestamp = new Date(currentTime.getTime() - (trackData.length - i) * threeHoursMs);
      } else if (p.type === 'Future') {
        timestamp = new Date(currentTime.getTime() + i * threeHoursMs);
      } else {
        timestamp = new Date();
      }

      let willBeAbnormal = false;
      if (p.type === 'History') {
        willBeAbnormal = (i % 5 === 0) || Math.random() < 0.15;
      } else if (p.type === 'Future') {
        willBeAbnormal = (i % 4 === 1) || Math.random() < 0.25;
      } else {
        willBeAbnormal = Math.random() < 0.1;
      }

      const speed = willBeAbnormal ? (Math.random() > 0.5 ? 28 + Math.random() * 12 : Math.random() * 3) : (8 + Math.random() * 15);
      const signalStrength = willBeAbnormal ? (-85 - Math.random() * 15) : (-45 - Math.random() * 35);
      const deviationFromRoute = willBeAbnormal ? (6 + Math.random() * 8) : (Math.random() * 4);
      const inRestrictedZone = willBeAbnormal && Math.random() > 0.8;
      const hasTask = Math.random() > 0.6;

      const base = {
        ...p,
        id: shiptype === 'fishing' ? `fishing_ChonBuri_${i + 1}` : `cargo_THLCH${i + 1}`,
        timestamp: timestamp.toISOString(),
        speed: speed,
        signalStrength: signalStrength,
        deviationFromRoute: deviationFromRoute,
        inRestrictedZone: inRestrictedZone,
        hasTask: hasTask,
        taskType: hasTask ? (willBeAbnormal ? ['異常調查', '緊急追蹤', '威脅評估'][Math.floor(Math.random() * 3)] : ['監控任務', '追蹤任務', '偵察任務'][Math.floor(Math.random() * 3)]) : null,
        taskDescription: hasTask ? (willBeAbnormal ? '處理異常行為和信號異常事件' : '執行船舶監控和行為分析') : null
      };

      // Ensure predefined Future points are rendered with the warm yellow used elsewhere
      if (base.type === 'Future') {
        base.backgroundColor = '#FFD54A';
        base.dotColor = '#FFD54A';
      }

      // normalize to canonical point before returning so consumers get the canonical shape
      const canonical = (typeof createCanonicalPoint === 'function') ? createCanonicalPoint(base, { legacy: true }) : (function(){ base.id = base.id || base.pointId; base.trackPointData = Object.assign({}, base); return base; })();
      return canonical;
    });
  };
})();
