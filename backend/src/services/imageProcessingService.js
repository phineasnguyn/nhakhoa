/**
 * Image Processing Service Client
 * Client để gọi image processing service (cắt 4 góc răng và augmentation)
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

class ImageProcessingService {
  async computeOverlay(metadata) {
    const response = await this.client.post('/api/process/overlay-metadata', metadata, { timeout: 30000 });
    return response.data;
  }
  constructor() {
    this.baseURL = process.env.IMAGE_PROCESSING_SERVICE_URL || 'http://localhost:8001';
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 300000, // 5 minutes timeout cho xử lý ảnh
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const response = await this.client.get('/api/health');
      return response.data;
    } catch (error) {
      console.error('Image processing service health check failed:', error.message);
      throw new Error('Image processing service is not available');
    }
  }

  /**
   * Xử lý cắt 4 góc răng
   * @param {Array} images - Array of { path, filename } hoặc Buffer objects
   * @param {Array} annotations - Array of { path, filename } hoặc Buffer objects
   * @returns {Promise<Buffer>} ZIP file buffer
   */
  async divideCorners(images, annotations) {
    try {
      console.log(`=== imageProcessingService.divideCorners ===`);
      console.log(`Input: ${images.length} images, ${annotations.length} annotations`);
      
      const formData = new FormData();
      let imageCount = 0;
      let annotationCount = 0;

      // Thêm images
      for (const img of images) {
        console.log(`Adding image: filename=${img.filename}, buffer size=${img.buffer?.length}`);
        if (img.path) {
          // File path
          formData.append('images', fs.createReadStream(img.path), {
            filename: img.filename || path.basename(img.path)
          });
          imageCount++;
        } else if (img.buffer) {
          // Buffer
          formData.append('images', img.buffer, {
            filename: img.filename || 'image.jpg'
          });
          imageCount++;
        }
      }

      // Thêm annotations
      for (const ann of annotations) {
        console.log(`Adding annotation: filename=${ann.filename}`);
        if (ann.path) {
          // File path
          formData.append('annotations', fs.createReadStream(ann.path), {
            filename: ann.filename || path.basename(ann.path)
          });
          annotationCount++;
        } else if (ann.buffer) {
          // Buffer
          formData.append('annotations', ann.buffer, {
            filename: ann.filename || 'annotation.txt'
          });
          annotationCount++;
        }
      }

      console.log(`FormData prepared: ${imageCount} images, ${annotationCount} annotations appended`);

      const response = await this.client.post('/api/process/divide-corners-batch', formData, {
        headers: {
          ...formData.getHeaders()
        },
        responseType: 'arraybuffer'
      });

      return response.data;
    } catch (error) {
      console.error('Error processing divide-corners:', error.message);
      throw new Error(`Failed to process images: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Xử lý data augmentation
   * @param {Array} images - Array of { path, filename } hoặc Buffer objects
   * @param {Array} annotations - Array of { path, filename } hoặc Buffer objects
   * @param {Object} options - { augmentations: string[], createSubfolders: boolean }
   * @returns {Promise<Buffer>} ZIP file buffer
   */
  async augmentDataset(images, annotations, options = {}) {
    try {
      const formData = new FormData();

      // Thêm images
      for (const img of images) {
        if (img.path) {
          formData.append('images', fs.createReadStream(img.path), {
            filename: img.filename || path.basename(img.path)
          });
        } else if (img.buffer) {
          formData.append('images', img.buffer, {
            filename: img.filename || 'image.jpg'
          });
        }
      }

      // Thêm annotations
      for (const ann of annotations) {
        if (ann.path) {
          formData.append('annotations', fs.createReadStream(ann.path), {
            filename: ann.filename || path.basename(ann.path)
          });
        } else if (ann.buffer) {
          formData.append('annotations', ann.buffer, {
            filename: ann.filename || 'annotation.txt'
          });
        }
      }

      // Thêm options
      if (options.augmentations && Array.isArray(options.augmentations)) {
        formData.append('augmentations', options.augmentations.join(','));
      }
      
      if (typeof options.createSubfolders === 'boolean') {
        formData.append('create_subfolders', options.createSubfolders.toString());
      }

      const response = await this.client.post('/api/process/augment', formData, {
        headers: {
          ...formData.getHeaders()
        },
        responseType: 'arraybuffer'
      });

      return response.data;
    } catch (error) {
      console.error('Error processing augmentation:', error.message);
      throw new Error(`Failed to augment dataset: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Lấy danh sách augmentations có sẵn
   * @returns {Promise<Object>}
   */
  async getAvailableAugmentations() {
    try {
      const response = await this.client.get('/api/augmentations');
      return response.data;
    } catch (error) {
      console.error('Error getting augmentations:', error.message);
      throw new Error('Failed to get available augmentations');
    }
  }

  /**
   * Xử lý từ MinIO URLs
   * @param {Array} imageUrls - Array of MinIO presigned URLs
   * @param {Array} annotationUrls - Array of MinIO presigned URLs
   * @returns {Promise<Buffer>} ZIP file buffer
   */
  async divideCornersByUrls(imageUrls, annotationUrls) {
    try {
      // Download files từ URLs
      const images = await Promise.all(
        imageUrls.map(async (url, index) => {
          const response = await axios.get(url, { responseType: 'arraybuffer' });
          return {
            buffer: response.data,
            filename: `image_${index + 1}.jpg`
          };
        })
      );

      const annotations = await Promise.all(
        annotationUrls.map(async (url, index) => {
          const response = await axios.get(url, { responseType: 'text' });
          return {
            buffer: Buffer.from(response.data),
            filename: `annotation_${index + 1}.txt`
          };
        })
      );

      return await this.divideCorners(images, annotations);
    } catch (error) {
      console.error('Error processing by URLs:', error.message);
      throw new Error('Failed to process images from URLs');
    }
  }
}

module.exports = new ImageProcessingService();
