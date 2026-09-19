const express = require('express');
const router = express.Router();
const authController = require('../controllers/AuthController');
const userController = require('../controllers/UserController');
const patientController = require('../controllers/PatientController');
const visitController = require('../controllers/VisitController');
const imageController = require('../controllers/ImageController');
const bulkUploadController = require('../controllers/BulkUploadController');
const imageProcessingController = require('../controllers/ImageProcessingController');
const annotationController = require('../controllers/AnnotationController');
const exportController = require('../controllers/ExportController');
const indexController = require('../controllers/index');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const patientSchemas = require('../validators/patientValidator');
const visitSchemas = require('../validators/visitValidator');
const imageSchemas = require('../validators/imageValidator');
const multer = require('multer');

// Configure multer for file uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB per file (for high-quality images)
        files: 5000, // Max 5000 files for large bulk uploads
        fieldSize: 25 * 1024 * 1024 // 25MB for text fields (e.g., large JSON metadata)
    }
});

// Root routes
router.get('/', indexController.getHello);
router.get('/api/status', indexController.getStatus);

// Auth routes
router.post('/api/auth/login', authController.login);
router.post('/api/auth/logout', authController.logout);
router.get('/api/auth/profile', authController.getProfile);
router.post('/api/auth/refresh', authController.refreshToken);

// User routes
router.get('/api/users', userController.getAllUsers);
router.get('/api/users/:id', userController.getUserById);
router.post('/api/users', userController.createUser);
router.put('/api/users/:id', userController.updateUser);
router.delete('/api/users/:id', userController.deleteUser);
router.delete('/api/users', userController.deleteAllUsers); // Delete all users

// Patient routes
router.get('/api/patients', patientController.getAllPatients);
router.get('/api/patients/search', patientController.searchPatients);
router.get('/api/patients/:id', patientController.getPatientById);
router.post('/api/patients', validate(patientSchemas.create), patientController.createPatient);
router.put('/api/patients/:id', validate(patientSchemas.update), patientController.updatePatient);
router.delete('/api/patients/:id', authenticate, patientController.deletePatient);

// Visit routes
router.get('/api/visits', visitController.getAllVisits);
router.get('/api/visits/:id', visitController.getVisitById);
router.get('/api/patients/:patientId/visits', visitController.getVisitsByPatientId);
router.post('/api/visits', validate(visitSchemas.create), visitController.createVisit);
router.put('/api/visits/:id', validate(visitSchemas.update), visitController.updateVisit);
router.delete('/api/visits/:id', visitController.deleteVisit);

// Image routes
router.get('/api/images', imageController.getAllImages);
router.get('/api/visits/:visitId/images', imageController.getImagesByVisitId);
router.get('/api/visits/:visitId/images/:category', imageController.getImagesByCategory);
router.post('/api/images', upload.single('image'), validate(imageSchemas.create), imageController.createImage);
router.put('/api/images/:id/validation', validate(imageSchemas.updateValidation), imageController.updateValidationStatus);
router.post('/api/images/:id/rotate', upload.single('image'), imageController.rotateImage);
router.delete('/api/images/:id', imageController.deleteImage);

// Bulk upload routes (COCO format - legacy)
router.post('/api/bulk-upload', upload.any(), bulkUploadController.bulkUpload);
router.get('/api/bulk-upload/history', bulkUploadController.getUploadHistory);

// Bulk upload routes (YOLO format - new)
router.post('/api/bulk-upload-yolo', upload.any(), bulkUploadController.bulkUploadYolo);

// Stained bulk upload routes
router.post('/api/bulk-upload/stained', upload.array('images', 20), bulkUploadController.uploadStainedImages);
router.get('/api/visits/:visitId/stained-upload-status', bulkUploadController.getStainedUploadStatus);
router.get('/api/patients/:patientId/available-visits', bulkUploadController.getAvailableVisitsForStained);

// Image processing routes
router.post('/api/visits/:visitId/process-images', authenticate, imageProcessingController.processRawImages);
router.get('/api/visits/:visitId/processing-status', authenticate, imageProcessingController.getProcessingStatus);

// Annotation routes
router.get('/api/images/:imageId/annotations', annotationController.getImageAnnotations);
router.put('/api/annotations/:annotationId/plaque', authenticate, annotationController.updatePlaqueStatus);
router.post('/api/images/:imageId/annotations/batch', annotationController.batchUpdateAnnotations);
router.get('/api/visits/:visitId/annotations/stats', annotationController.getVisitStats);

// Export routes
router.post('/api/export/dataset', authenticate, exportController.exportDataset);
router.get('/api/exports/:exportId', authenticate, exportController.getExportStatus);
router.get('/api/exports/:exportId/download', authenticate, exportController.downloadExport);
router.delete('/api/exports/:exportId', authenticate, exportController.deleteExport);

// Proxy route for MinIO images (to avoid CORS issues)
router.get('/api/images/proxy/*', async (req, res) => {
  try {
    const objectName = req.params[0]; // Everything after /api/images/proxy/
    console.log('Proxying image request for:', objectName);
    
    const storageService = require('../services/storage');
    const imageBuffer = await storageService.downloadFile(objectName);
    
    // Set appropriate content type based on file extension
    const ext = objectName.split('.').pop().toLowerCase();
    const contentType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 
                       ext === 'png' ? 'image/png' : 'image/jpeg';
    
    // Set CORS headers explicitly for image proxy
    res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(imageBuffer);
  } catch (error) {
    console.error('Error proxying image:', error);
    res.status(404).json({ error: 'Image not found' });
  }
});

function setRoutes(app) {
    app.use('/', router);
}

module.exports = setRoutes;
