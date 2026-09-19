import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { usePatient, useUpdatePatient, useDeletePatient } from '../hooks/usePatients';
import { usePatientVisits, useCreateVisit } from '../../visits/hooks/useVisits';
import { formatDate, formatDateTime } from '../../../utils/formatters';
import LoadingSpinner from '../../../components/ui/LoadingSpinner';
import EmptyState from '../../../components/ui/EmptyState';
import Button from '../../../components/ui/Button';
import Modal from '../../../components/ui/Modal';
import StatusBadge from '../../../components/ui/StatusBadge';
import { VISIT_STATUS_LABELS } from '../../../constants';
import './PatientDetailPage.css';

/**
 * PatientDetailPage
 * Complete example showing best practices:
 * - Separation of concerns (UI, business logic, API)
 * - Loading, error, and empty states
 * - React Query for data fetching
 * - Composable components
 * - Clean, readable code
 */
const PatientDetailPage = () => {
  const { patientId } = useParams();
  const navigate = useNavigate();

  // State for modals
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isVisitModalOpen, setIsVisitModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  // Fetch patient data
  const { 
    data: patientResponse, 
    isLoading: isLoadingPatient, 
    error: patientError 
  } = usePatient(patientId);

  // Fetch patient visits
  const { 
    data: visitsResponse, 
    isLoading: isLoadingVisits 
  } = usePatientVisits(patientId);

  // Mutations
  const updatePatient = useUpdatePatient();
  const deletePatient = useDeletePatient();
  const createVisit = useCreateVisit();

  // Extract data
  const patient = patientResponse?.data?.patient;
  const visits = visitsResponse?.data?.visits || [];

  // Loading state
  if (isLoadingPatient) {
    return (
      <div className="page-container">
        <LoadingSpinner size="lg" text="Đang tải thông tin bệnh nhân..." />
      </div>
    );
  }

  // Error state
  if (patientError) {
    return (
      <div className="page-container">
        <EmptyState
          icon="⚠️"
          title="Có lỗi xảy ra"
          message={patientError.response?.data?.message || 'Không thể tải thông tin bệnh nhân'}
          action={
            <Button onClick={() => navigate('/patients')}>
              Quay lại danh sách
            </Button>
          }
        />
      </div>
    );
  }

  // Not found state
  if (!patient) {
    return (
      <div className="page-container">
        <EmptyState
          icon="🔍"
          title="Không tìm thấy bệnh nhân"
          message="Bệnh nhân không tồn tại hoặc đã bị xóa"
          action={
            <Button onClick={() => navigate('/patients')}>
              Quay lại danh sách
            </Button>
          }
        />
      </div>
    );
  }

  // Handlers
  const handleEditPatient = (formData) => {
    updatePatient.mutate(
      { id: patientId, data: formData },
      {
        onSuccess: () => {
          setIsEditModalOpen(false);
        }
      }
    );
  };

  const handleDeletePatient = () => {
    deletePatient.mutate(patientId, {
      onSuccess: () => {
        navigate('/patients');
      }
    });
  };

  const handleCreateVisit = (formData) => {
    createVisit.mutate(
      { ...formData, patient_id: patientId },
      {
        onSuccess: () => {
          setIsVisitModalOpen(false);
        }
      }
    );
  };

  const handleVisitClick = (visitId) => {
    navigate(`/visits/${visitId}`);
  };

  return (
    <div className="page-container">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <button className="back-button" onClick={() => navigate('/patients')}>
            ← Quay lại
          </button>
          <h1 className="page-title">{patient.name}</h1>
          <p className="page-subtitle">
            Mã BN: {patient.id} • Ngày tạo: {formatDate(patient.created_at)}
          </p>
        </div>
        <div className="page-actions">
          <Button variant="ghost" onClick={() => setIsEditModalOpen(true)}>
            ✏️ Sửa
          </Button>
          <Button variant="danger" onClick={() => setIsDeleteModalOpen(true)}>
            🗑️ Xóa
          </Button>
        </div>
      </div>

      {/* Patient Info Card */}
      <div className="info-card">
        <h2 className="section-title">Thông tin cá nhân</h2>
        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">Họ tên:</span>
            <span className="info-value">{patient.name}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Số điện thoại:</span>
            <span className="info-value">{patient.phone || '—'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Ngày sinh:</span>
            <span className="info-value">{patient.dob ? formatDate(patient.dob) : '—'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Giới tính:</span>
            <span className="info-value">
              {patient.gender === 'male' ? 'Nam' : patient.gender === 'female' ? 'Nữ' : 'Khác'}
            </span>
          </div>
          {patient.notes && (
            <div className="info-item info-item-full">
              <span className="info-label">Ghi chú:</span>
              <span className="info-value">{patient.notes}</span>
            </div>
          )}
        </div>
      </div>

      {/* Visits Section */}
      <div className="visits-section">
        <div className="section-header">
          <h2 className="section-title">Lịch sử khám ({visits.length})</h2>
          <Button variant="primary" onClick={() => setIsVisitModalOpen(true)}>
            + Tạo lượt khám mới
          </Button>
        </div>

        {isLoadingVisits ? (
          <LoadingSpinner text="Đang tải lịch sử khám..." />
        ) : visits.length === 0 ? (
          <EmptyState
            icon="📋"
            title="Chưa có lượt khám nào"
            message="Tạo lượt khám đầu tiên cho bệnh nhân này"
            action={
              <Button variant="primary" onClick={() => setIsVisitModalOpen(true)}>
                + Tạo lượt khám
              </Button>
            }
          />
        ) : (
          <div className="visits-list">
            {visits.map((visit) => (
              <div 
                key={visit.id} 
                className="visit-card"
                onClick={() => handleVisitClick(visit.id)}
              >
                <div className="visit-header">
                  <div className="visit-date">
                    <span className="visit-label">Ngày khám:</span>
                    <span className="visit-value">{formatDate(visit.visit_date)}</span>
                  </div>
                  <StatusBadge 
                    status={visit.status} 
                    label={VISIT_STATUS_LABELS[visit.status]} 
                  />
                </div>
                <div className="visit-details">
                  <div className="visit-detail-item">
                    <span className="visit-label">Mã CA:</span>
                    <span className="visit-value">{visit.case_id || '—'}</span>
                  </div>
                  <div className="visit-detail-item">
                    <span className="visit-label">Tạo lúc:</span>
                    <span className="visit-value">{formatDateTime(visit.created_at)}</span>
                  </div>
                </div>
                {visit.notes && (
                  <p className="visit-notes">{visit.notes}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit Patient Modal */}
      <Modal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        title="Sửa thông tin bệnh nhân"
        size="md"
      >
        <PatientForm
          patient={patient}
          onSubmit={handleEditPatient}
          onCancel={() => setIsEditModalOpen(false)}
          isSubmitting={updatePatient.isPending}
        />
      </Modal>

      {/* Create Visit Modal */}
      <Modal
        isOpen={isVisitModalOpen}
        onClose={() => setIsVisitModalOpen(false)}
        title="Tạo lượt khám mới"
        size="md"
      >
        <VisitForm
          patientId={patientId}
          onSubmit={handleCreateVisit}
          onCancel={() => setIsVisitModalOpen(false)}
          isSubmitting={createVisit.isPending}
        />
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title="Xác nhận xóa"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setIsDeleteModalOpen(false)}>
              Hủy
            </Button>
            <Button 
              variant="danger" 
              onClick={handleDeletePatient}
              loading={deletePatient.isPending}
            >
              Xóa bệnh nhân
            </Button>
          </>
        }
      >
        <p>Bạn có chắc chắn muốn xóa bệnh nhân <strong>{patient.name}</strong>?</p>
        <p className="warning-text">Toàn bộ lần khám, ảnh và chú thích liên quan sẽ bị xóa vĩnh viễn. Hành động này không thể hoàn tác.</p>
      </Modal>
    </div>
  );
};

/**
 * PatientForm Component (extracted for reusability)
 */
const PatientForm = ({ patient = null, onSubmit, onCancel, isSubmitting }) => {
  const [formData, setFormData] = useState({
    name: patient?.name || '',
    phone: patient?.phone || '',
    dob: patient?.dob ? patient.dob.split('T')[0] : '',
    gender: patient?.gender || 'male',
    notes: patient?.notes || ''
  });

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="form">
      <div className="form-group">
        <label htmlFor="name">Họ tên *</label>
        <input
          id="name"
          name="name"
          type="text"
          value={formData.name}
          onChange={handleChange}
          required
          className="form-input"
        />
      </div>

      <div className="form-group">
        <label htmlFor="phone">Số điện thoại</label>
        <input
          id="phone"
          name="phone"
          type="tel"
          value={formData.phone}
          onChange={handleChange}
          className="form-input"
        />
      </div>

      <div className="form-group">
        <label htmlFor="dob">Ngày sinh</label>
        <input
          id="dob"
          name="dob"
          type="date"
          value={formData.dob}
          onChange={handleChange}
          className="form-input"
        />
      </div>

      <div className="form-group">
        <label htmlFor="gender">Giới tính</label>
        <select
          id="gender"
          name="gender"
          value={formData.gender}
          onChange={handleChange}
          className="form-input"
        >
          <option value="male">Nam</option>
          <option value="female">Nữ</option>
          <option value="other">Khác</option>
        </select>
      </div>

      <div className="form-group">
        <label htmlFor="notes">Ghi chú</label>
        <textarea
          id="notes"
          name="notes"
          value={formData.notes}
          onChange={handleChange}
          rows="3"
          className="form-input"
        />
      </div>

      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Hủy
        </Button>
        <Button type="submit" variant="primary" loading={isSubmitting}>
          {patient ? 'Cập nhật' : 'Tạo mới'}
        </Button>
      </div>
    </form>
  );
};

/**
 * VisitForm Component (extracted for reusability)
 */
const VisitForm = ({ patientId, onSubmit, onCancel, isSubmitting }) => {
  const [formData, setFormData] = useState({
    visit_date: new Date().toISOString().split('T')[0],
    case_id: '',
    status: 'pending',
    notes: ''
  });

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="form">
      <div className="form-group">
        <label htmlFor="visit_date">Ngày khám *</label>
        <input
          id="visit_date"
          name="visit_date"
          type="date"
          value={formData.visit_date}
          onChange={handleChange}
          required
          className="form-input"
        />
      </div>

      <div className="form-group">
        <label htmlFor="case_id">Mã CA (Case ID)</label>
        <input
          id="case_id"
          name="case_id"
          type="text"
          value={formData.case_id}
          onChange={handleChange}
          placeholder="Nhập mã CA nếu có"
          className="form-input"
        />
      </div>

      <div className="form-group">
        <label htmlFor="status">Trạng thái</label>
        <select
          id="status"
          name="status"
          value={formData.status}
          onChange={handleChange}
          className="form-input"
        >
          <option value="pending">Chờ xử lý</option>
          <option value="in_progress">Đang xử lý</option>
          <option value="completed">Hoàn thành</option>
        </select>
      </div>

      <div className="form-group">
        <label htmlFor="notes">Ghi chú</label>
        <textarea
          id="notes"
          name="notes"
          value={formData.notes}
          onChange={handleChange}
          rows="3"
          className="form-input"
        />
      </div>

      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Hủy
        </Button>
        <Button type="submit" variant="primary" loading={isSubmitting}>
          Tạo lượt khám
        </Button>
      </div>
    </form>
  );
};

export default PatientDetailPage;
