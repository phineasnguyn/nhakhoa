import apiClient from './apiClient';
import { imageApiUrl } from './imagePresentation';

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
      const url = imageApiUrl(`visits/${visitId}/process-images`);
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
  async getProcessingStatus(visitId, jobId, signal) {
    const response = await apiClient.get(imageApiUrl(`visits/${visitId}/processing-status`), { params: { jobId }, signal, timeout: 15000 });
    return response.data;
  }

  async rotateImage(imageId, payload) {
    const response = await apiClient.post(imageApiUrl(`images/${imageId}/rotate`), payload, { timeout: 60000 });
    return response.data;
  }

  /**
   * Poll processing status until completed or failed
   */
  pollProcessingStatus(visitId, onProgress, { jobId, intervalMs = 3000, timeoutMs = 900000 } = {}) {
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      let failures = 0;
      while (!controller.signal.aborted && Date.now() < deadline) {
        try {
          const { data } = await this.getProcessingStatus(visitId, jobId, controller.signal);
          failures = 0;
          onProgress?.(data);
          if (['completed', 'failed', 'partial', 'review_required', 'none'].includes(data.status)) return data;
        } catch (error) {
          if (controller.signal.aborted || [401, 403, 404].includes(error.response?.status) || ++failures >= 3) throw error;
        }
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new Error('Đã dừng theo dõi xử lý')); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, intervalMs);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
      }
      throw new Error('Hết thời gian theo dõi; job vẫn có thể đang chạy. Vui lòng tải lại trạng thái.');
    };
    return { promise: poll(), stop: () => controller.abort() };
  }
}

export default new ImageService();
