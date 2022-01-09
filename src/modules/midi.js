const midi = require('midi');
const usbDetect = require('usb-detection');
const debounce = require('lodash.debounce');

const watchdogTimeout = 600 * 1000;
const maxRangeDelay = 1000; // for ranges should be at least 2 events per maxRangeDelay

module.exports = async (mqtt, config, log) => {
  const input = new midi.Input();
  let lastMessage = { date: 0, message: {}}; // for detect midi disconnect, watchdogTimeout
  let modulePaused = false;
  const lastMidi = {}; // for detect range bounces, maxRangeDelay

  // main handler
  function onMidiMessage(deltaTime, m) {
    // The message is an array of numbers corresponding to the MIDI bytes:
    //   [status, data1, data2]
    // https://www.cs.cf.ac.uk/Dave/Multimedia/node158.html has some helpful
    // information interpreting the messages.

    if (modulePaused) return;

    let keys = '';
    let sendMqtt = '';

    addHistory(m); // for lastMidi

    // на yamaha pss-a50 дргебезжат эти каналы
    // TODO: to config
    if (m == 248 || m == 254) {
      return;
    }

    // находим, что нажато из конфига
    for (let hk of config.hotkeys.filter(hk => hk.type !== 'range')) {
      if(m[0] == hk.midi[0] && m[1] == hk.midi[1] && m[2] == hk.midi[2]) {
        if (hk.keys) keys = hk.keys;
        if (hk.mqtt) sendMqtt = hk.mqtt;
        break;
      }
    }

    // находим ranges
    for (let hk of config.hotkeys.filter(hk => hk.type === 'range')) {
      if(m[0] == hk.midi[0] && m[1] == hk.midi[1]) {
        debouncedMidiHandlerRange({
          val: m[2],
          m,
          hk,
        });
        break;
      }
    }

    doActions({keys, sendMqtt});
    log(`m: ${m} d: ${deltaTime}`);

    lastMessage.date = Date.now();
    lastMessage.message = m;
  }

  // lastMidi - for detect random range events
  const getMidiKey = m => `${m[0]}-${m[1]}`;
  function addHistory(m) {
    const key = getMidiKey(m);

    // delete old last
    // единичное изменение в течение секунды игнорируем
    // если в прошлый раз сигнал был давно, считаем, что сейчас первый сигнал
    const last = getHistory(m);
    const delta = last?.dateLast - Date.now();
    if (delta > maxRangeDelay) delete(lastMidi[key]);

    // create
    if (!lastMidi[key]) lastMidi[key] = {
      key,
      dateLast: null,
      datePrev: null,
    }

    // update
    lastMidi[key].m = m;
    lastMidi[key].datePrev = lastMidi[key].dateLast;
    lastMidi[key].dateLast = Date.now();
  }
  const getHistory = m => lastMidi[getMidiKey(m)];

  // executa keys or mqtt
  function doActions({keys = '', sendMqtt}) {
    // обработка кнопок, если keys назначены
    if (keys) {
      let [mods, key] = keys.split(' ');
      mods = mods.split('+');
      if (key) {
        log(`press ${keys}`);
        robot.keyTap(key, mods);
      }
    }
  
    if (sendMqtt) {
      log(`send mqtt: ${sendMqtt[0]} ${sendMqtt[1]}`);
      mqtt.publish(sendMqtt[0], sendMqtt[1]);
    }
  }
  
  // send mqtt for range controls change
  // convert midi value to out value
  // should be debounced
  function midiHandlerRange({ hk, val, m }) {
    let sendMqtt, keys;

    const last = getHistory(m);
    if (!last?.datePrev) {
      console.log('Single midi signal, ignore it:', m);
      return;
    }

    val = getValFromMidi({
      val: val,
      hk
    });

    if (hk.mqtt) {
      sendMqtt = {...hk.mqtt};
      sendMqtt[1] = sendMqtt[1].replace(/\{\{payload\}\}/g, `${val}`);
    }
    if (hk.keys) keys = hk.keys;

    doActions({keys, sendMqtt});
  }
  const debouncedMidiHandlerRange = debounce(midiHandlerRange, 500);
  
  function getValFromMidi({ val, hk }) {
    const min = hk.min || 0;
    const max = hk.max || 127;
    const to_min = hk.to_min || 0;
    const to_max = hk.to_max || 10;
  
    const valPercent = (val - min) / (max - min);
    const to_val = to_min + valPercent * (to_max - to_min);
    // console.log(to_val);
    return Math.round(to_val);
  }
  

  // проверка, что интервал не отваливается после перезагрузки, а таймаут отваливается
  setInterval(() => {
    // log('Interval');
    const isNoMidi = lastMessage.date - Date.now() > watchdogTimeout;
    if (isNoMidi) openMidi();
  }, watchdogTimeout);



  const isDeviceConfigured = config.device?.vid && config.device?.pid;

  // переподключение, когда найдено midi устройство
  usbDetect.startMonitoring();
  if (isDeviceConfigured) {
    usbDetect.on(`add:${config.device.vid}:${config.device.pid}`, function(device) {
      console.log('add', device);
      setTimeout(openMidi, 500);
    });
    listenKeys();
  }
  else {
    console.log('Try to reconnect your midi device to see config');
    // list all devices add
    usbDetect.on(`add`, function(device) {
      console.log('add', device);
      console.log('add to midi: {} section in config:');
      console.log(`portName: '${device.deviceName}',`);
      console.log(`device: { vid: ${device.vendorId}, pid: ${device.productId} },`)
    });
  }


  function openMidi() {
    if (input.isPortOpen()) {
      log('Close midi port');
      input.closePort();
    }

    // Count the available input ports.
    const portCount = input.getPortCount();
    const ports = [];
    const portsStr = [];
    log('Total midi ports: ' + portCount);

    for (let p = 0; p < portCount; p++) {
      const portName = input.getPortName(p);
      ports.push(portName);
      portsStr.push(`${p}: ${portName}`);
    }

    // get portNum
    let portNum = ports.findIndex(p => p == config.portName);
    if (portNum === -1) portNum = config.portNum;
    log(`MIDI ports: ${portsStr.join(', ')}.`);

    if (portNum === undefined){
      log(`Cannot find MIDI device "${config.portName}"`);
      return;
    }
    else log(`Try to using port ${portNum}`);

    input.openPort(portNum);
  }

  function listenKeys() {
    log('midi listen start');

    // Configure a callback.
    input.on('message', onMidiMessage);

    // Sysex, timing, and active sensing messages are ignored
    // by default. To enable these message types, pass false for
    // the appropriate type in the function below.
    // Order: (Sysex, Timing, Active Sensing)
    // For example if you want to receive only MIDI Clock beats
    // you should use
    // input.ignoreTypes(true, false, true)
    input.ignoreTypes(false, false, false);

    mqtt.on('connect', openMidi);

    openMidi();
  }

  function onStop() {
    modulePaused = true;
    log('Stop midi listening');
  }
  function onStart() {
    modulePaused = false;
    log('Start midi listening');
  }

  return {
    subscriptions: [],
    onStop,
    onStart
  }
}