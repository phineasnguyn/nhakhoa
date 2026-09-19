require('dotenv').config();
const express = require('express');
const app = require('./app');
const db = require('./config/database');

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const server = app.listen(PORT, async () => {
    console.log('==============================');
    console.log(`Server is running on port ${PORT}`);
    console.log(`Environment: ${NODE_ENV}`);
    console.log('==============================');

    const dbConfig = db.pool.options || db.pool;
    console.log('🔗 Database config:');
    console.log(`   Host: ${dbConfig.host}`);
    console.log(`   Port: ${dbConfig.port}`);
    console.log(`   User: ${dbConfig.user}`);
    console.log(`   Database: ${dbConfig.database}`);

    try {
        await db.pool.query('SELECT 1');
        console.log('✅ Database connection: SUCCESS');
    } catch (err) {
        console.error('❌ Database connection: FAILED');
        console.error(err.message);
    }
    try {
        const minioClient = require('./config/minio');
        console.log('🔗 MinIO config:');
        console.log(`   EndPoint: ${minioClient.endPoint}`);
        console.log(`   Port: ${minioClient.port}`);
        console.log(`   UseSSL: ${minioClient.useSSL}`);
        console.log(`   AccessKey: ${minioClient.accessKey}`);
        await minioClient.listBuckets()
            .then(buckets => {
                console.log('✅ MinIO connection: SUCCESS');
                console.log(`   Buckets: ${buckets.map(b => b.name).join(', ') || '(none)'}`);
            })
            .catch(err => {
                console.error('❌ MinIO connection: FAILED');
                console.error(err.message);
            });
        const BUCKET_NAME = process.env.MINIO_BUCKET || 'nhakhoa';
        const exists = await minioClient.bucketExists(BUCKET_NAME);
        if (!exists) {
            await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
            console.log(`✅ Bucket '${BUCKET_NAME}' created`);
        } else {
            console.log(`✅ Bucket '${BUCKET_NAME}' already exists`);
        }
    } catch (err) {
        console.error('❌ MinIO config/bucket: FAILED');
        console.error(err.message);
    }

    try {
        const { startWorker } = require('./workers/imageProcessor');
        startWorker();
        console.log('✅ Image processing worker: STARTED');
    } catch (err) {
        console.error('❌ Image processing worker: FAILED TO START');
        console.error(err.message);
    }
});

async function gracefulShutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    try {
        const { stopWorker } = require('./workers/imageProcessor');
        await stopWorker();
    } catch (e) {
        console.error('Worker shutdown error:', e.message);
    }
    try {
        await db.pool.end();
        console.log('Database pool closed');
    } catch (e) {
        console.error('Database pool close error:', e.message);
    }
    try {
        const { connection } = require('./config/queue');
        await connection.quit();
        console.log('Redis connection closed');
    } catch (e) {
        console.error('Redis close error:', e.message);
    }
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));