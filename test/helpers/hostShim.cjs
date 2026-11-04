'use strict';
// Preloaded into a plain Node child so modelHost.js sees the process.parentPort surface utilityProcess provides.
process.parentPort = {
  postMessage: (message) => process.send(message),
  on: (event, listener) => {
    if (event === 'message') process.on('message', (data) => listener({ data }));
  },
};
