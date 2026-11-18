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
updateStatus();
terra.log('ready,', devs.size, 'remembered controller(s), ride keys', rideEnabled ? 'on' : 'off');
