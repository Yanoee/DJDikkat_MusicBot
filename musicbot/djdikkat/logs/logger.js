/************************************************************
 * DJ DIKKAT - Music Bot
 * Bot Logger
 * Build 0.1
 * Author: Yanoee
 ************************************************************/

const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');

const LOG_DIR = path.join(__dirname, './');
fs.mkdirSync(LOG_DIR, { recursive: true });

const logger = createLogger({
  level: 'debug',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.File({ filename: path.join(LOG_DIR, 'bot.log'), level: 'debug' }),
    new transports.File({ filename: path.join(LOG_DIR, 'error.log'), level: 'error' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new transports.Console({
    level: 'debug',
    format: format.combine(
      format.colorize(),
      format.timestamp(),
      format.printf(({ timestamp, level, message, stack }) => {
        const msg = stack || message;
        return `[${timestamp}] ${level}: ${msg}`;
      })
    )
  }));
}

module.exports = logger;
