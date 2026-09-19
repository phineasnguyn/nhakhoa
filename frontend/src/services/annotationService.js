import apiClient from './apiClient';
import { imageApiUrl } from './imagePresentation';

const annotationService = {
  /**
   * Get all annotations with subboxes for an image
   */
  async getImageAnnotations(imageId) {
    try {
      const response = await apiClient.get(imageApiUrl(`images/${imageId}/annotations`));
      return response.data;
    } catch (error) {
      console.error('Error getting image annotations:', error);
      throw error;
    }
  },

  /**
   * Update plaque status for a single annotation/subbox
   */
  async updatePlaqueStatus(annotationId, plaqueStatus, userId) {
    try {
      const response = await apiClient.put(imageApiUrl(`annotations/${annotationId}/plaque`), {
        plaque_status: plaqueStatus,
        user_id: userId
      });
      return response.data;
    } catch (error) {
      console.error('Error updating plaque status:', error);
      throw error;
    }
  },

  /**
   * Batch update multiple annotations
   */
  async batchUpdateAnnotations(imageId, annotations, userId) {
    try {
      const response = await apiClient.post(`api/images/${imageId}/annotations/batch`, {
        annotations,
        user_id: userId
      });
      return response.data;
    } catch (error) {
      console.error('Error batch updating annotations:', error);
      throw error;
    }
  },

  /**
   * Get annotation statistics for a visit
   */
  async getVisitStats(visitId) {
    try {
      const response = await apiClient.get(`api/visits/${visitId}/annotations/stats`);
      return response.data;
    } catch (error) {
      console.error('Error getting visit stats:', error);
      throw error;
    }
  }
};

export default annotationService;
