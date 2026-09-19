import apiClient from './apiClient';

/**
 * Patient Service
 * Handles all patient-related API calls
 */
class PatientService {
  /**
   * Get paginated list of patients
   */
  async getPatients({ page = 1, limit = 10, search = '', sortBy = 'created_at', sortOrder = 'desc' }) {
    const response = await apiClient.get('/patients', {
      params: { page, limit, search, sortBy, sortOrder }
    });
    return response.data;
  }

  /**
   * Get single patient by ID
   */
  async getPatient(id) {
    const response = await apiClient.get(`/patients/${id}`);
    return response.data;
  }

  /**
   * Search patients by name or phone
   */
  async searchPatients(query) {
    const response = await apiClient.get('/patients/search', {
      params: { q: query }
    });
    return response.data;
  }

  /**
   * Create new patient
   */
  async createPatient(patientData) {
    const response = await apiClient.post('/patients', patientData);
    return response.data;
  }

  /**
   * Update patient
   */
  async updatePatient(id, patientData) {
    const response = await apiClient.put(`/patients/${id}`, patientData);
    return response.data;
  }

  /**
   * Permanently delete patient and all related data
   */
  async deletePatient(id) {
    const response = await apiClient.delete(`/patients/${id}`);
    return response.data;
  }
}

export default new PatientService();
