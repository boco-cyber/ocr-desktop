const fs = require('fs');
const path = require('path');

class Logger {
  constructor({ logDir, logFilePath }) {
    this.logDir = logDir || path.dirname(logFilePath);
    this.logFile = logFilePath || path.join(this.logDir, 'ocr-orchestration.log');
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  write(level, event, details = {}) {
    const entry = {
      at: new Date().toISOString(),
      level,
      event,
      details,
    };
    const line = JSON.stringify(entry);
    fs.appendFileSync(this.logFile, line + '\n');
    const sink = level === 'error' ? console.error : console.log;
    sink(`[${level}] ${event}`, details);
  }

  info(event, details) {
    this.write('info', event, details);
  }

  warn(event, details) {
    this.write('warn', event, details);
  }

  error(event, details) {
    this.write('error', event, details);
  }
}

module.exports = { Logger };
