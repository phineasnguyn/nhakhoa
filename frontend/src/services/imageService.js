import apiClient from './apiClient';

/**
 * Image Service
 * Handles all image-related API calls
 */
class ImageService {
  /**
   * Get all images for a visit
   */
  async getVisitImages(visitId, category = null) {
    const response = await apiClient.get(`/images/visit/${visitId}`, {
      params: { category }
    });
    return response.data;
  }

  /**
   * Upload single image
   */
  async uploadImage(visitId, imageData) {
    const formData = new FormData();
    formData.append('image', imageData.file);
    formData.append('image_category', imageData.category);
    formData.append('image_type', imageData.type);
    formData.append('image_index', imageData.index);
    if (imageData.notes) {
      formData.append('notes', imageData.notes);
    }

    const response = await apiClient.post(`/images/${visitId}/upload`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });
    return response.data;
  }

  /**
   * Update image validation status
   */
  async updateValidationStatus(imageId, status) {
    const response = await apiClient.put(`/images/${imageId}/validation`, {
      validation_status: status
    });
    return response.data;
  }

  /**
   * Delete image (soft delete)
   */
  async deleteImage(imageId) {
    const response = await apiClient.delete(`/images/${imageId}`);
    return response.data;
  }

  /**
   * Bulk upload images
   */
  async bulkUpload(formData) {
    const response = await apiClient.post('/bulk-upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });
    return response.data;
  }

  /**
   * Get bulk upload history
   */
  async getBulkUploadHistory() {
    const response = await apiClient.get('/bulk-upload/history');
    return response.data;
  }

  /**
   * Process raw images (enqueue async job)
   */
  async processImages(visitId) {
    console.log('imageService.processImages called with visitId:', visitId);
    
    try {
      const url = `/api/visits/${visitId}/process-images`;
      const response = await apiClient.post(url, {}, {
        timeout: 30000
      });
      
      return response.data;
    } catch (error) {
      console.error('imageService.processImages error:', error);
      throw error;
    }
  }

  /**
   * Get processing status
   */
  async getProcessingStatus(visitId) {
    const response = await apiClient.get(`/api/visits/${visitId}/processing-status`);
    return response.data;
  }

  /**
   * Poll processing status until completed or failed
   */
  pollProcessingStatus(visitId, onProgress, intervalMs = 3000) {
    let stopped = false;

    const poll = async () => {
      while (!stopped) {
        try {
          const result = await this.getProcessingStatus(visitId);
          const data = result.data;

          if (onProgress) {
            onProgress(data);
          }

          if (data.status === 'completed' || data.status === 'failed' || data.status === 'none') {
            return data;
          }
        } catch (err) {
          console.error('Poll error:', err);
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    };

    const promise = poll();

    return {
      promise,
      stop: () => { stopped = true; },
    };
  }
}

export default new ImageService();
