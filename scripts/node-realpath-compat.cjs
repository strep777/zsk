const fs = require('node:fs');
const original = fs.realpathSync.native;
fs.realpathSync.native = function (...args) {
  try { return original.apply(fs, args); }
  catch (error) { if (error.code !== 'EPERM') throw error; return fs.realpathSync(...args); }
};
