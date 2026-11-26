// Entry point: load config, build the UI, restore controllers paired earlier.
cfg = await loadCfg();
rideEnabled = await terra.storage.get('rideEnabled', true);
consoleUiEnabled = await terra.storage.get('consoleUiEnabled', true);
autoVirtualShift = await terra.storage.get('autoVirtualShift', true);
buildPanel();
applyShare();
startAutoSelect();
if (typeof scheduleConsoleUi === 'function') scheduleConsoleUi();
terra.onCleanup(() => { terra.ble.setShared(false).catch(() => {}); });

for (const device of await terra.ble.remembered()) {
  const dev = register(device);
  if (dev) keepAlive(dev);
}
const coreBus = typeof window !== 'undefined' && window.__terraCore && window.__terraCore.bus;
if (coreBus && typeof coreBus.on === 'function') {
  const offAuto = coreBus.on('ble:autoconnected', ({ deviceId }) => {
    const dev = [...devs].find((d) => d.device && d.device.id === deviceId);
    if (!dev || dev.up || stopped) return;
    dev._retryIdx = 0;
    wakeKeepAlive(dev);
    keepAlive(dev);
  });
  terra.onCleanup(offAuto);
}
updateStatus();
terra.log('ready,', devs.size, 'remembered controller(s), ride keys', rideEnabled ? 'on' : 'off');
