const { Patient } = require('../models');
const patientDeletionService = require('../services/patientDeletionService');

class PatientController {
    async getAllPatients(req, res) {
        try {
            const { page, limit, search, status, sortBy, sortOrder } = req.query;
            const result = await Patient.findAll({ page, limit, search, status, sortBy, sortOrder });
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('Error fetching patients:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async getPatientById(req, res) {
        try {
            const { id } = req.params;
            const patient = await Patient.findById(id);
            
            if (!patient) {
                return res.status(404).json({ success: false, error: 'Patient not found' });
            }
            
            res.json({ success: true, data: patient });
        } catch (error) {
            console.error('Error fetching patient:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async searchPatients(req, res) {
        try {
            const { q, page, limit } = req.query;
            
            if (!q) {
                return res.status(400).json({ success: false, error: 'Search query is required' });
            }
            
            const result = await Patient.findAll({ search: q, page, limit });
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('Error searching patients:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async createPatient(req, res) {
        try {
            const { name, phone, dob, gender, notes } = req.body;
            
            if (!name) {
                return res.status(400).json({ success: false, error: 'Name is required' });
            }
            
            const patient = await Patient.create({ name, phone, dob, gender, notes });
            res.status(201).json({ success: true, data: patient });
        } catch (error) {
            console.error('Error creating patient:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async updatePatient(req, res) {
        try {
            const { id } = req.params;
            const { name, phone, dob, gender, notes } = req.body;
            
            const patient = await Patient.update(id, { name, phone, dob, gender, notes });
            
            if (!patient) {
                return res.status(404).json({ success: false, error: 'Patient not found' });
            }
            
            res.json({ success: true, data: patient });
        } catch (error) {
            console.error('Error updating patient:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async deletePatient(req, res) {
        try {
            const { id } = req.params;
            const result = await patientDeletionService.deletePatient(id);
            const storageCleanupPending = result.storageCleanupStatus !== 'completed';
            res.status(storageCleanupPending ? 202 : 200).json({
                success: true,
                message: storageCleanupPending
                    ? 'Đã xóa bệnh nhân. Ảnh trong MinIO đang được hệ thống tiếp tục dọn dẹp.'
                    : 'Đã xóa bệnh nhân và toàn bộ dữ liệu liên quan',
                data: result
            });
        } catch (error) {
            console.error('Error deleting patient:', error);
            res.status(error.statusCode || 500).json({
                success: false,
                code: error.code || 'PATIENT_DELETE_FAILED',
                message: error.message || 'Không thể xóa bệnh nhân'
            });
        }
    }
}

module.exports = new PatientController();
