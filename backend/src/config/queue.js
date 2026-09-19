const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
});

connection.on('connect', () => {
  console.log('Redis connected successfully');
});

connection.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

const imageProcessingQueue = new Queue('image-processing', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

module.exports = {
  imageProcessingQueue,
  connection,
};
