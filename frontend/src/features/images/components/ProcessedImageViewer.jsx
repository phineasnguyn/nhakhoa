import { useState, useEffect, useRef } from 'react';
import Button from '../../../components/ui/Button';
import LoadingSpinner from '../../../components/ui/LoadingSpinner';
import { FiUpload, FiX, FiZoomIn, FiChevronLeft, FiChevronRight, FiRotateCw, FiRotateCcw, FiCheck } from 'react-icons/fi';
import AnnotationCanvas from '../../../components/AnnotationCanvas';
import { canViewProcessed, isOverlay, displayImageUrl, withImageUrls } from '../../../services/imagePresentation';
import annotationService from '../../../services/annotationService';
import imageService from '../../../services/imageService';
import { useAuth } from '../../auth/hooks/useAuth';
import toast from 'react-hot-toast';

const ProcessedImageViewer = ({
  visitId,
  rawImages = [],
  processedImages = [],
  stainedImages = [],
  onProcessClick,
  onImagesUpdate,
  onImageUpload
}) => {
  const [viewMode, setViewMode] = useState('raw'); // 'raw' or 'processed'
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [lightboxImage, setLightboxImage] = useState(null); // { url, label, position, stainedUrl, imageId, image }
  const [annotations, setAnnotations] = useState([]); // teeth array with subboxes
  const annotationRequest = useRef(0);
  const [annotationsStatus, setAnnotationsStatus] = useState('idle');
  const [annotationStats, setAnnotationStats] = useState(null);
  const [rotation, setRotation] = useState(0); // Current rotation angle (0, 90, 180, 270)
  const [isRotating, setIsRotating] = useState(false); // Saving rotation in progress
  const [recentlyRotated, setRecentlyRotated] = useState(false); // Flag to suppress warning during rotation
  const { user: currentUser, isAuthenticated } = useAuth();

  const hasProcessed = processedImages.some(canViewProcessed);

  const displayImages = viewMode === 'processed' ? processedImages : rawImages;

  // Đóng lightbox khi nhấn ESC
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape' && lightboxImage) {
        setLightboxImage(null);
        setRotation(0); // Reset rotation when closing
        setAnnotations([]); // Clear annotations
        setAnnotationStats(null); // Clear stats
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [lightboxImage]);

  // Tìm ảnh stained cùng vị trí
  const findStainedImage = (position) => {
    return stainedImages.find(img => {
      if (img.image_index === position.index) return true;

      const imgType = img.image_type?.toLowerCase() || '';
      const posType = position.type.toLowerCase();

      if (imgType.includes(posType)) return true;

      if (position.altTypes) {
        return position.altTypes.some(alt => imgType.includes(alt.toLowerCase()));
      }

      return false;
    });
  };

  // Rotation handlers
  const handleRotateLeft = () => {
    setRotation((prev) => (prev - 90 + 360) % 360);
  };

  const handleRotateRight = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleCancelRotation = () => {
    setRotation(0);
  };

  const handleSaveRotation = async () => {
    if (rotation === 0) {
      toast('Không có thay đổi góc xoay');
      return;
    }

    if (!lightboxImage?.imageId) {
      toast.error('Không tìm thấy thông tin ảnh');
      return;
    }

    setIsRotating(true);
    setRecentlyRotated(true);
    try {
      const result = await imageService.rotateImage(lightboxImage.imageId, {
        rotation,
        image_revision: lightboxImage.image.image_revision,
        annotation_revision: lightboxImage.image.annotation_revision,
      });

      toast.success('Đã lưu ảnh xoay thành công!');
      setRotation(0);
      setAnnotations([]); // Clear old annotations
      setAnnotationStats(null); // Clear old stats
      setLightboxImage(null);

      // Reload images to show rotated image immediately
      if (onImagesUpdate) {
        await onImagesUpdate();
      }

      // Show success message after images are reloaded
      // Existing labels and geometry have already been rotated atomically.

      // Automatically trigger reprocessing if needed
      if (result.needsReprocessing && onProcessClick) {
        setTimeout(async () => {
          try {
            await onProcessClick();
            toast.success('Ảnh đã được xử lý lại với góc xoay mới!');
            setRecentlyRotated(false);
          } catch (err) {
            console.error('Auto-reprocess error:', err);
            toast.error('Không thể tự động xử lý lại. Vui lòng nhấn nút Process.');
            setRecentlyRotated(false);
          }
        }, 1000);
      } else {
        // Fallback: clear flag after 3 seconds if no auto-reprocess
        setTimeout(() => setRecentlyRotated(false), 3000);
      }
    } catch (err) {
      console.error('Rotation error:', err);
      toast.error('Không thể lưu ảnh xoay: ' + err.message);
      setRecentlyRotated(false);
    } finally {
      setIsRotating(false);
    }
  };

  const handleProcessClick = async () => {
    setProcessing(true);
    setError(null);

    try {
      console.log('Calling onProcessClick...');
      const result = await onProcessClick();
      console.log('onProcessClick result:', result);

      // Only set processing to false after receiving result
      if (result && result.success) {
        toast.success(result.message || 'Xử lý ảnh thành công!');
        setViewMode('processed');
      } else {
        throw new Error(result?.message || 'Xử lý không thành công');
      }
    } catch (err) {
      const errorMsg = err.message || 'Có lỗi xảy ra khi xử lý ảnh';
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      // Always set processing to false when done
      setProcessing(false);
    }
  };

  // Load annotations for an image
  const loadAnnotationsForImage = async (imageId) => {
    const request = ++annotationRequest.current;
    setAnnotationsStatus('loading');
    setAnnotations([]);
    try {
      console.log('🔍 Loading annotations for image:', imageId);
      const result = await annotationService.getImageAnnotations(imageId);
      console.log('✅ Annotations loaded:', result);
      console.log('📊 Teeth count:', result.data?.teeth?.length);
      console.log('📊 Progress:', result.data?.progress);
      console.log('🦷 Full teeth structure:', JSON.stringify(result.data?.teeth, null, 2));
      if (request !== annotationRequest.current) return;
      setAnnotationsStatus('ready');
      setAnnotations(result.data?.teeth || []);
      setLightboxImage(current => {
        if (current?.imageId !== imageId) return current;
        const image = withImageUrls(result.data.image);
        return { ...current, image, url: image.url, urlProcessed: image.url_processed };
      });
      // Ensure percentage is a number
      const progress = result.data?.progress;
      if (progress && typeof progress === 'object') {
        setAnnotationStats({
          ...progress,
          percentage: parseFloat(progress.percentage) || 0
        });
      } else {
        setAnnotationStats(null);
      }
    } catch (err) {
      if (request !== annotationRequest.current) return;
      setAnnotationsStatus('error');
      toast.error('Không thể tải annotations');
      setAnnotations([]);
      setAnnotationStats(null);
    }
  };

  // Handle subbox click to toggle plaque status
  const handleSubboxClick = async (subbox, tooth) => {
    if (!isAuthenticated || !currentUser) {
      toast.error('Vui lòng đăng nhập để sử dụng tính năng annotation');
      return;
    }

    const newStatus = subbox.plaque_status === 1 ? 0 : 1;

    // Optimistic update: immediately update local state for instant UI feedback
    setAnnotations(prev => prev.map(t => {
      if (t.annotation_id !== tooth.annotation_id) return t;
      return {
        ...t,
        subboxes: t.subboxes.map(sb => {
          if (sb.subbox_id !== subbox.subbox_id) return sb;
          return { ...sb, plaque_status: newStatus };
        })
      };
    }));

    toast.success(newStatus === 1 ? '🔴 Có mảng bám' : '🟢 Không có mảng bám', { duration: 1500 });

    try {
      await annotationService.updatePlaqueStatus(
        subbox.subbox_id,
        newStatus,
        currentUser.id
      );
      await loadAnnotationsForImage(lightboxImage.imageId);
      onImagesUpdate?.();
    } catch (err) {
      console.error('Failed to update plaque status:', err);
      toast.error('Có lỗi xảy ra, đang khôi phục...');
      // Revert optimistic update on failure
      setAnnotations(prev => prev.map(t => {
        if (t.annotation_id !== tooth.annotation_id) return t;
        return {
          ...t,
          subboxes: t.subboxes.map(sb => {
            if (sb.subbox_id !== subbox.subbox_id) return sb;
            return { ...sb, plaque_status: subbox.plaque_status };
          })
        };
      }));
    }
  };

  // Navigate between images in lightbox
  const navigateImage = (direction) => {
    if (!lightboxImage) return;

    const positions = [
      { index: 1, type: 'upper_right', label: 'Upper Right', altTypes: ['top_right'] },
      { index: 2, type: 'upper_middle', label: 'Upper Middle', altTypes: ['upper_center', 'top_middle'] },
      { index: 3, type: 'upper_left', label: 'Upper Left', altTypes: ['top_left'] },
      { index: 4, type: 'middle_right', label: 'Middle Right', altTypes: ['central_right'] },
      { index: 5, type: 'middle_middle', label: 'Middle Middle', altTypes: ['central_middle'] },
      { index: 6, type: 'middle_left', label: 'Middle Left', altTypes: ['central_left'] },
      { index: 7, type: 'lower_right', label: 'Lower Right', altTypes: ['bottom_right'] },
      { index: 8, type: 'lower_middle', label: 'Lower Middle', altTypes: ['lower_center', 'bottom_middle'] },
      { index: 9, type: 'lower_left', label: 'Lower Left', altTypes: ['bottom_left'] }
    ];

    const currentIndex = positions.findIndex(p => p.index === lightboxImage.position.index);
    let nextIndex = currentIndex + direction;

    // Wrap around
    if (nextIndex < 0) nextIndex = positions.length - 1;
    if (nextIndex >= positions.length) nextIndex = 0;

    const nextPosition = positions[nextIndex];

    // Find next image
    const nextImage = displayImages.find(img => {
      if (img.image_index === nextPosition.index) return true;
      const imgType = img.image_type?.toLowerCase() || '';
      const posType = nextPosition.type.toLowerCase();
      if (imgType.includes(posType)) return true;
      if (nextPosition.altTypes) {
        return nextPosition.altTypes.some(alt => imgType.includes(alt.toLowerCase()));
      }
      return false;
    });

    if (nextImage) {
      const stainedImage = findStainedImage(nextPosition);

      setLightboxImage({
        url: nextImage.url,  // Always raw URL
        urlProcessed: nextImage.url_processed,  // Processed URL if available
        label: nextPosition.label,
        position: nextPosition,
        stainedUrl: stainedImage?.url,
        imageId: nextImage.id,
        image: nextImage
      });

      // Load annotations for new image
      if (nextImage.id) {
        loadAnnotationsForImage(nextImage.id);
      }
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (!lightboxImage) return;

      if (e.key === 'ArrowLeft') {
        navigateImage(-1);
      } else if (e.key === 'ArrowRight') {
        navigateImage(1);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [lightboxImage]);

  const renderGrid = () => {
    const positions = [
      { index: 1, type: 'upper_right', label: 'Upper Right', altTypes: ['top_right'] },
      { index: 2, type: 'upper_middle', label: 'Upper Middle', altTypes: ['upper_center', 'top_middle'] },
      { index: 3, type: 'upper_left', label: 'Upper Left', altTypes: ['top_left'] },
      { index: 4, type: 'middle_right', label: 'Middle Right', altTypes: ['central_right'] },
      { index: 5, type: 'middle_middle', label: 'Middle Middle', altTypes: ['central_middle'] },
      { index: 6, type: 'middle_left', label: 'Middle Left', altTypes: ['central_left'] },
      { index: 7, type: 'lower_right', label: 'Lower Right', altTypes: ['bottom_right'] },
      { index: 8, type: 'lower_middle', label: 'Lower Middle', altTypes: ['lower_center', 'bottom_middle'] },
      { index: 9, type: 'lower_left', label: 'Lower Left', altTypes: ['bottom_left'] }
    ];

    return positions.map((pos) => {
      // Find image by image_index OR by matching image_type
      const image = displayImages.find(img => {
        // First try exact index match
        if (img.image_index === pos.index) return true;

        // Then try matching image_type (handle both formats)
        const imgType = img.image_type?.toLowerCase() || '';
        const posType = pos.type.toLowerCase();

        // Check main type
        if (imgType.includes(posType)) return true;

        // Check alternative types
        if (pos.altTypes) {
          return pos.altTypes.some(alt => imgType.includes(alt.toLowerCase()));
        }

        return false;
      });

      const imageUrl = displayImageUrl(image, viewMode);
      const openImage = event => {
        event.stopPropagation();
        const stainedImage = findStainedImage(pos);
        setLightboxImage({ url: image.url, urlProcessed: image.url_processed, label: pos.label,
          position: pos, stainedUrl: stainedImage?.url, imageId: image.id, image });
        loadAnnotationsForImage(image.id);
      };

      return (
        <div
          key={pos.index}
          style={{
            aspectRatio: '1',
            display: 'flex',
            flexDirection: 'column',
            border: imageUrl ? '1px solid #f1f5f9' : '1px dashed #e2e8f0',
            borderRadius: '4px',
            padding: '4px',
            backgroundColor: imageUrl ? '#fff' : '#fafbfc',
            cursor: !imageUrl && viewMode === 'raw' ? 'pointer' : 'default',
            transition: 'all 0.2s ease',
            boxShadow: imageUrl ? '0 1px 2px rgba(0,0,0,0.04)' : 'none'
          }}
          onClick={!imageUrl && viewMode === 'raw' && onImageUpload ?
            () => onImageUpload('raw', pos.type, pos.index) :
            undefined
          }
        >
          {imageUrl ? (
            <>
              <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                marginBottom: '4px',
                backgroundColor: '#fafafa',
                borderRadius: '3px',
                position: 'relative'
              }}>
                {viewMode === 'processed' && isOverlay(image) ? (
                  <AnnotationCanvas imageUrl={imageUrl} teeth={image.teeth || []}
                    imageWidth={image.width} imageHeight={image.height} onImageClick={openImage} />
                ) : (
                  <img src={imageUrl} alt={pos.label} onClick={openImage}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'pointer' }} />
                )}
                {viewMode === 'processed' && canViewProcessed(image) && (
                  <div style={{
                    position: 'absolute',
                    top: '4px',
                    right: '4px',
                    background: '#10b981',
                    color: 'white',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontSize: '9px',
                    fontWeight: '600'
                  }}>
                    ✓ Processed
                  </div>
                )}
              </div>
              <div style={{
                fontSize: '9px',
                color: '#94a3b8',
                textAlign: 'center',
                paddingTop: '2px',
                borderTop: '1px solid #f1f5f9'
              }}>
                {pos.label}
              </div>
            </>
          ) : (
            <>
              <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px dashed #e2e8f0',
                borderRadius: '3px',
                backgroundColor: '#f8fafc',
                marginBottom: '4px'
              }}>
                {viewMode === 'raw' ? (
                  <>
                    <FiUpload size={18} color="#cbd5e1" />
                    <div style={{ fontSize: '9px', color: '#94a3b8', marginTop: '4px', fontWeight: '500' }}>
                      Click để upload
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: '9px', color: '#cbd5e1' }}>
                    ⏳ Chưa xử lý
                  </div>
                )}
              </div>
              <div style={{
                fontSize: '9px',
                color: '#cbd5e1',
                textAlign: 'center',
                paddingTop: '2px',
                borderTop: '1px solid #f1f5f9'
              }}>
                {pos.label}
              </div>
            </>
          )}
        </div>
      );
    });
  };

  return (
    <div style={{
      background: '#fff',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      height: '100%'
    }}>
      {/* Lightbox Overlay - Split Screen */}
      {lightboxImage && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.95)',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            padding: '20px',
            cursor: 'pointer'
          }}
          onClick={() => {
            setLightboxImage(null);
            setRotation(0);
            setAnnotations([]);
            setAnnotationStats(null);
          }}
        >
          {/* Nút đóng */}
          <button
            style={{
              position: 'absolute',
              top: '20px',
              right: '20px',
              background: 'rgba(255, 255, 255, 0.2)',
              border: 'none',
              color: 'white',
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              fontSize: '20px',
              transition: 'all 0.2s',
              backdropFilter: 'blur(10px)',
              zIndex: 10000
            }}
            onClick={(e) => {
              e.stopPropagation();
              setLightboxImage(null);
              setRotation(0);
              setAnnotations([]); // Clear annotations
              setAnnotationStats(null); // Clear stats
            }}
            onMouseEnter={(e) => {
              e.target.style.background = 'rgba(255, 255, 255, 0.3)';
            }}
            onMouseLeave={(e) => {
              e.target.style.background = 'rgba(255, 255, 255, 0.2)';
            }}
          >
            <FiX size={24} />
          </button>

          {/* Rotation Controls */}
          <div style={{
            position: 'absolute',
            bottom: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: '12px',
            alignItems: 'center',
            background: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(10px)',
            padding: '12px 16px',
            borderRadius: '16px',
            zIndex: 10000
          }}>
            {/* Rotate Left */}
            <button
              style={{
                background: 'rgba(255, 255, 255, 0.2)',
                border: 'none',
                color: 'white',
                width: '40px',
                height: '40px',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onClick={(e) => {
                e.stopPropagation();
                handleRotateLeft();
              }}
              onMouseEnter={(e) => {
                e.target.style.background = 'rgba(255, 255, 255, 0.3)';
                e.target.style.transform = 'scale(1.1)';
              }}
              onMouseLeave={(e) => {
                e.target.style.background = 'rgba(255, 255, 255, 0.2)';
                e.target.style.transform = 'scale(1)';
              }}
              title="Xoay trái 90°"
            >
              <FiRotateCcw size={20} />
            </button>

            {/* Rotation Display */}
            <div style={{
              color: 'white',
              fontSize: '14px',
              fontWeight: '600',
              minWidth: '50px',
              textAlign: 'center'
            }}>
              {rotation}°
            </div>

            {/* Rotate Right */}
            <button
              style={{
                background: 'rgba(255, 255, 255, 0.2)',
                border: 'none',
                color: 'white',
                width: '40px',
                height: '40px',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onClick={(e) => {
                e.stopPropagation();
                handleRotateRight();
              }}
              onMouseEnter={(e) => {
                e.target.style.background = 'rgba(255, 255, 255, 0.3)';
                e.target.style.transform = 'scale(1.1)';
              }}
              onMouseLeave={(e) => {
                e.target.style.background = 'rgba(255, 255, 255, 0.2)';
                e.target.style.transform = 'scale(1)';
              }}
              title="Xoay phải 90°"
            >
              <FiRotateCw size={20} />
            </button>

            {/* Divider */}
            {rotation !== 0 && (
              <>
                <div style={{
                  width: '1px',
                  height: '40px',
                  background: 'rgba(255, 255, 255, 0.2)',
                  margin: '0 4px'
                }} />

                {/* Cancel Button */}
                <button
                  style={{
                    background: 'rgba(239, 68, 68, 0.3)',
                    border: 'none',
                    color: 'white',
                    padding: '8px 16px',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: '500',
                    transition: 'all 0.2s'
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCancelRotation();
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.background = 'rgba(239, 68, 68, 0.5)';
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = 'rgba(239, 68, 68, 0.3)';
                  }}
                >
                  <FiX size={16} />
                  Hủy
                </button>

                {/* Save Button */}
                <button
                  style={{
                    background: 'rgba(16, 185, 129, 0.3)',
                    border: 'none',
                    color: 'white',
                    padding: '8px 16px',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    cursor: isRotating ? 'wait' : 'pointer',
                    fontSize: '13px',
                    fontWeight: '500',
                    transition: 'all 0.2s',
                    opacity: isRotating ? 0.6 : 1
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isRotating) {
                      handleSaveRotation();
                    }
                  }}
                  onMouseEnter={(e) => {
                    if (!isRotating) {
                      e.target.style.background = 'rgba(16, 185, 129, 0.5)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = 'rgba(16, 185, 129, 0.3)';
                  }}
                  disabled={isRotating}
                >
                  <FiCheck size={16} />
                  {isRotating ? 'Đang lưu...' : 'Lưu'}
                </button>
              </>
            )}
          </div>

          {/* Label */}
          <div style={{
            position: 'absolute',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(255, 255, 255, 0.2)',
            backdropFilter: 'blur(10px)',
            color: 'white',
            padding: '8px 20px',
            borderRadius: '20px',
            fontSize: '14px',
            fontWeight: '600',
            zIndex: 10000
          }}>
            {lightboxImage.label}
          </div>

          {/* Annotation Stats */}
          {viewMode === 'processed' && annotationStats && typeof annotationStats === 'object' && (
            <div style={{
              position: 'absolute',
              top: '20px',
              left: '20px',
              background: 'rgba(0, 0, 0, 0.8)',
              backdropFilter: 'blur(10px)',
              color: 'white',
              padding: '12px 16px',
              borderRadius: '12px',
              fontSize: '12px',
              zIndex: 10000,
              minWidth: '200px'
            }}>
              <div style={{ fontWeight: '600', marginBottom: '8px', fontSize: '13px' }}>
                📊 Annotation Progress
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#94a3b8' }}>Total subbox:</span>
                  <span style={{ fontWeight: '600' }}>{annotationStats.total}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#94a3b8' }}>No plaque:</span>
                  <span style={{ fontWeight: '600', color: '#10b981' }}>{annotationStats.total - annotationStats.plaque_detected}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#94a3b8' }}>Has plaque:</span>
                  <span style={{ fontWeight: '600', color: '#ef4444' }}>{annotationStats.plaque_detected}</span>
                </div>
              </div>
            </div>
          )}

          {/* Navigation Buttons */}
          <button
            style={{
              position: 'absolute',
              top: '50%',
              left: '20px',
              transform: 'translateY(-50%)',
              background: 'rgba(255, 255, 255, 0.2)',
              backdropFilter: 'blur(10px)',
              border: 'none',
              color: 'white',
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s',
              zIndex: 10000
            }}
            onClick={(e) => {
              e.stopPropagation();
              navigateImage(-1);
            }}
            onMouseEnter={(e) => {
              e.target.style.background = 'rgba(255, 255, 255, 0.3)';
              e.target.style.transform = 'translateY(-50%) scale(1.1)';
            }}
            onMouseLeave={(e) => {
              e.target.style.background = 'rgba(255, 255, 255, 0.2)';
              e.target.style.transform = 'translateY(-50%) scale(1)';
            }}
          >
            <FiChevronLeft size={28} />
          </button>

          <button
            style={{
              position: 'absolute',
              top: '50%',
              right: '20px',
              transform: 'translateY(-50%)',
              background: 'rgba(255, 255, 255, 0.2)',
              backdropFilter: 'blur(10px)',
              border: 'none',
              color: 'white',
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s',
              zIndex: 10000
            }}
            onClick={(e) => {
              e.stopPropagation();
              navigateImage(1);
            }}
            onMouseEnter={(e) => {
              e.target.style.background = 'rgba(255, 255, 255, 0.3)';
              e.target.style.transform = 'translateY(-50%) scale(1.1)';
            }}
            onMouseLeave={(e) => {
              e.target.style.background = 'rgba(255, 255, 255, 0.2)';
              e.target.style.transform = 'translateY(-50%) scale(1)';
            }}
          >
            <FiChevronRight size={28} />
          </button>

          {/* Split Screen Container */}
          <div style={{
            flex: 1,
            display: 'flex',
            gap: '20px',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: '60px',
            marginBottom: '40px',
            minHeight: 0,
            overflow: 'hidden'
          }}>
            {/* Left: Raw/Processed với annotation overlay */}
            <div style={{
              flex: 1,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 0,
              minWidth: 0
            }}>
              <div style={{
                background: 'rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(10px)',
                color: 'white',
                padding: '6px 16px',
                borderRadius: '12px',
                fontSize: '13px',
                fontWeight: '600',
                marginBottom: '12px'
              }}>
                {viewMode === 'processed' ? '🔍 Processed' : '📷 Raw'}
              </div>
              {(() => {
                const shouldShowCanvas = viewMode === 'processed' && isOverlay(lightboxImage.image);
                const displayUrl = displayImageUrl({ ...lightboxImage.image, url: lightboxImage.url, url_processed: lightboxImage.urlProcessed }, viewMode);
                if (shouldShowCanvas && annotationsStatus !== 'ready') return <p role="status" style={{ color: 'white' }}>
                  {annotationsStatus === 'error' ? 'Không tải được khung đánh giá. Vui lòng mở lại ảnh.' : 'Đang tải khung đánh giá…'}
                </p>;

                return shouldShowCanvas ? (
                  <div style={{
                    transform: `rotate(${rotation}deg)`,
                    transition: 'transform 0.3s ease',
                    maxWidth: '100%',
                    maxHeight: '100%',
                    width: '100%',
                    height: '100%',
                    minHeight: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    <AnnotationCanvas
                      imageUrl={displayUrl}
                      teeth={annotations}
                      imageWidth={lightboxImage.image.width}
                      imageHeight={lightboxImage.image.height}
                      onSubboxClick={handleSubboxClick}
                    />
                  </div>
                ) : (
                  <img
                    src={displayUrl}
                    alt={lightboxImage.label}
                    style={{
                      maxWidth: '100%',
                      maxHeight: '100%',
                      objectFit: 'contain',
                      borderRadius: '8px',
                      boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
                      transform: `rotate(${rotation}deg)`,
                      transition: 'transform 0.3s ease'
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                );
              })()}
            </div>

            {/* Divider */}
            <div style={{
              width: '2px',
              height: '80%',
              background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.3), transparent)'
            }} />

            {/* Right: Stained */}
            <div style={{
              flex: 1,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 0,
              minWidth: 0
            }}>
              <div style={{
                background: 'rgba(147, 51, 234, 0.3)',
                backdropFilter: 'blur(10px)',
                color: 'white',
                padding: '6px 16px',
                borderRadius: '12px',
                fontSize: '13px',
                fontWeight: '600',
                marginBottom: '12px'
              }}>
                 Stained
              </div>
              {lightboxImage.stainedUrl ? (
                <img
                  src={lightboxImage.stainedUrl}
                  alt={`${lightboxImage.label} Stained`}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    borderRadius: '8px',
                    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)'
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'rgba(255, 255, 255, 0.5)',
                  fontSize: '14px',
                  padding: '40px'
                }}>
                  <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔍</div>
                  <div>Không có ảnh stained cho vị trí này</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid #f1f5f9',
        background: '#f8fafc',
        flexShrink: 0,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start'
      }}>
        <div>
          <h3 style={{ margin: '0 0 2px 0', fontSize: '14px', color: '#334155', fontWeight: '600' }}>
            {viewMode === 'processed' ? ' Ảnh đã xử lý' : ' Ảnh RAW'} ({(viewMode === 'processed' ? processedImages.filter(canViewProcessed) : rawImages).length}/9)
          </h3>
          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8' }}>
            {viewMode === 'raw' ? 'Upload 9 ảnh gốc (chưa nhuộm) - Click ảnh để so sánh với stained' : 'Ảnh hậu xử lý - Click để so sánh với stained'}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {rawImages.length > 0 && !hasProcessed && (
            <Button
              onClick={handleProcessClick}
              disabled={processing}
              variant="primary"
            >
              {processing ? ' Đang xử lý...' : ' Xử lý ảnh'}
            </Button>
          )}

          {hasProcessed && (
            <>
              <Button
                onClick={handleProcessClick}
                disabled={processing}
                variant="secondary"
                size="small"
              >
                {processing ? '⏳ Đang xử lý lại...' : '🔄 Xử lý lại'}
              </Button>
              <div style={{ display: 'flex', gap: '4px' }}>
                <Button
                  onClick={() => setViewMode('raw')}
                  variant={viewMode === 'raw' ? 'primary' : 'secondary'}
                  size="small"
                >
                   Raw
                </Button>
                <Button
                  onClick={() => setViewMode('processed')}
                  variant={viewMode === 'processed' ? 'primary' : 'secondary'}
                  size="small"
                >
                   Processed
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {error && (
        <div style={{
          padding: '8px 12px',
          background: '#fee2e2',
          color: '#991b1b',
          margin: '8px',
          borderLeft: '3px solid #dc2626',
          fontSize: '11px',
          fontWeight: '500',
          borderRadius: '4px'
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* Warning when processed images are incomplete */}
      {hasProcessed && processedImages.filter(canViewProcessed).length < rawImages.length && !processing && !recentlyRotated && (
        <div style={{
          padding: '8px 12px',
          background: '#fff3cd',
          color: '#856404',
          margin: '8px',
          borderLeft: '3px solid #ffc107',
          fontSize: '11px',
          fontWeight: '500',
          borderRadius: '4px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span>
            ⚠️ Phát hiện thiếu ảnh đã xử lý ({processedImages.filter(canViewProcessed).length}/{rawImages.length}).
            Có thể xảy ra lỗi trong quá trình xử lý.
          </span>
          <button
            onClick={handleProcessClick}
            disabled={processing}
            style={{
              padding: '4px 12px',
              fontSize: '11px',
              fontWeight: '600',
              background: '#ffc107',
              color: '#000',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              whiteSpace: 'nowrap'
            }}
            onMouseEnter={(e) => e.target.style.background = '#ffb300'}
            onMouseLeave={(e) => e.target.style.background = '#ffc107'}
          >
            🔄 Xử lý lại
          </button>
        </div>
      )}

      {processing && (
        <div style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 20px',
          background: 'rgba(255, 255, 255, 0.95)',
          margin: '8px',
          borderRadius: '8px',
          border: '2px dashed #cbd5e1'
        }}>
          <LoadingSpinner size="large" />
          <p style={{ marginTop: '16px', color: '#667eea', fontWeight: '600', fontSize: '14px' }}>
            Đang xử lý ảnh, vui lòng đợi...
          </p>
          <p style={{ marginTop: '8px', color: '#999', fontSize: '12px' }}>
            Service đang cắt 4 góc răng và vẽ bounding boxes
          </p>
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '6px',
        padding: '8px'
      }}>
        {renderGrid()}
      </div>


    </div>
  );
};

export default ProcessedImageViewer;
