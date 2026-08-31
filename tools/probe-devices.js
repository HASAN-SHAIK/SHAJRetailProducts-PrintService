const { exec } = require('child_process');

const run = (command) =>
  new Promise((resolve, reject) => {
    exec(command, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(err);
      if (stderr && stderr.trim()) return resolve(`${stdout}\n${stderr}`);
      resolve(stdout);
    });
  });

const printSection = (title) => {
  console.log('');
  console.log('='.repeat(80));
  console.log(title);
  console.log('='.repeat(80));
};

const main = async () => {
  try {
    printSection('USB PRINTER DEVICES (Windows)');
    const usbCmd =
      'powershell -NoProfile -Command "Get-PnpDevice -PresentOnly | ' +
      "Where-Object { $_.InstanceId -like 'USB*' -and $_.FriendlyName -match 'Printer|POS|Thermal|USB' } | " +
      'Select-Object FriendlyName,InstanceId | Format-Table -AutoSize"';
    const usbOut = await run(usbCmd);
    console.log(usbOut.trim() || 'No USB printers found.');

    printSection('BLUETOOTH DEVICES (Windows)');
    const btCmd =
      'powershell -NoProfile -Command "Get-PnpDevice -PresentOnly | ' +
      "Where-Object { $_.Class -eq 'Bluetooth' -or $_.InstanceId -like 'BTH*' } | " +
      'Select-Object FriendlyName,InstanceId,Status | Format-Table -AutoSize"';
    const btOut = await run(btCmd);
    console.log(btOut.trim() || 'No Bluetooth devices found.');

    printSection('BLUETOOTH COM PORTS (Windows)');
    const comCmd =
      'powershell -NoProfile -Command "Get-PnpDevice -PresentOnly | ' +
      "Where-Object { $_.FriendlyName -match 'COM' -and $_.InstanceId -like 'BTH*' } | " +
      'Select-Object FriendlyName,InstanceId,Status | Format-Table -AutoSize"';
    const comOut = await run(comCmd);
    console.log(comOut.trim() || 'No Bluetooth COM ports found.');

    console.log('');
    console.log('Tip: For USB, set PRINTER_INTERFACE like: usb://VID/PID');
    console.log('Example: PRINTER_INTERFACE=usb://0x04b8/0x0202');
  } catch (err) {
    console.error('Probe failed:', err.message || err);
  }
};

main();
