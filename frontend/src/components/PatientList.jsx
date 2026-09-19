import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getPatients, searchPatients, deletePatient } from '../api'
import PatientForm from './PatientForm'
import toast from 'react-hot-toast';
import { FiPlus, FiSearch, FiEye, FiTrash2, FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight, FiX, FiArrowUp, FiArrowDown, FiRefreshCw, FiAlertCircle, FiCheckCircle } from 'react-icons/fi'

function PatientList() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  
  const [patients, setPatients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [deletingPatientId, setDeletingPatientId] = useState(null)
  
  // Get params from URL or use defaults
  const page = parseInt(searchParams.get('page')) || 1
  const limit = parseInt(searchParams.get('limit')) || 10
  const searchQuery = searchParams.get('search') || ''
  const sortBy = searchParams.get('sortBy') || 'name_id'
  const sortOrder = searchParams.get('sortOrder') || 'DESC'
  
  // Local state for search input (separate from URL params)
  const [searchInput, setSearchInput] = useState(searchQuery)
  const debounceRef = useRef(null)
  
  const [totalPages, setTotalPages] = useState(0)
  const [total, setTotal] = useState(0)

  // Sync searchInput when URL search param changes (e.g., browser back/forward)
  useEffect(() => {
    setSearchInput(searchQuery)
  }, [searchQuery])

  useEffect(() => {
    loadPatients()
  }, [searchParams])

  const loadPatients = async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams({
        page: page,
        limit: limit,
        sortBy: sortBy,
        sortOrder: sortOrder
      })
      if (searchQuery) {
        params.append('search', searchQuery)
      }
      const response = await getPatients(`?${params.toString()}`)
      setPatients(response.data.data || [])
      setTotal(response.data.pagination?.total || 0)
      setTotalPages(response.data.pagination?.totalPages || 0)
      setError(null)
    } catch (err) {
      setError('Không thể tải danh sách bệnh nhân')
      toast.error(err.message || 'Lỗi khi tải bệnh nhân');
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = (e) => {
    const query = e.target.value
    setSearchInput(query) // Update local state immediately (keeps input responsive)
    
    // Debounce the URL update
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    
    debounceRef.current = setTimeout(() => {
      const newParams = new URLSearchParams(searchParams)
      
      if (query) {
        newParams.set('search', query)
      } else {
        newParams.delete('search')
      }
      newParams.set('page', '1') // Reset to page 1
      
      setSearchParams(newParams)
    }, 400) // 400ms debounce
  }
  
  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  const getReprocessBadge = (totalVisits, reprocessedVisits) => {
    if (totalVisits === 0) {
      return (
        <span className="badge badge-secondary" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
          Chưa có lần khám
        </span>
      )
    }
    
    if (reprocessedVisits === 0) {
      return (
        <span className="badge badge-warning" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
          <FiAlertCircle size={12} />
          0/{totalVisits}
        </span>
      )
    } else if (reprocessedVisits === totalVisits) {
      return (
        <span className="badge badge-success" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
          <FiCheckCircle size={12} />
          {reprocessedVisits}/{totalVisits}
        </span>
      )
    } else {
      return (
        <span className="badge badge-info" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
          <FiRefreshCw size={12} />
          {reprocessedVisits}/{totalVisits}
        </span>
      )
    }
  }

  const handleDelete = async (patient) => {
    const totalVisits = patient.total_visits || 0
    const confirmed = window.confirm(
      `Bạn có chắc muốn xóa bệnh nhân ${patient.name}?\n\n` +
      `Thao tác này sẽ xóa vĩnh viễn ${totalVisits} lần khám, toàn bộ ảnh, chú thích và dữ liệu liên quan trong MinIO. Không thể hoàn tác.`
    )
    if (!confirmed) return

    try {
      setDeletingPatientId(patient.id)
      const response = await deletePatient(patient.id)
      toast.success(response.data?.message || 'Đã xóa bệnh nhân và dữ liệu liên quan')
      loadPatients()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Không thể xóa bệnh nhân')
    } finally {
      setDeletingPatientId(null)
    }
  }

  const handlePageChange = (newPage) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('page', newPage.toString())
    setSearchParams(newParams)
  }

  const handleLimitChange = (e) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('limit', e.target.value)
    newParams.set('page', '1') // Reset to page 1
    setSearchParams(newParams)
  }

  const handleSort = (field) => {
    const newParams = new URLSearchParams(searchParams)
    
    // Toggle sort order if clicking same field, otherwise default to DESC
    if (sortBy === field) {
      newParams.set('sortOrder', sortOrder === 'ASC' ? 'DESC' : 'ASC')
    } else {
      newParams.set('sortBy', field)
      newParams.set('sortOrder', 'DESC')
    }
    newParams.set('page', '1') // Reset to page 1
    
    setSearchParams(newParams)
  }

  const getSortIcon = (field) => {
    if (sortBy !== field) return null
    return sortOrder === 'ASC' ? <FiArrowUp size={14} /> : <FiArrowDown size={14} />
  }



  if (loading) return <div className="loading">Đang tải...</div>
  if (error) return <div className="error">{error}</div>

  return (
    <div className="card">
      {/* Header with actions */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        marginBottom: '20px',
        gap: '20px'
      }}>
        <h2 style={{ margin: 0 }}>Danh Sách Bệnh Nhân</h2>
        
        <button 
          className="button"
          onClick={() => navigate('/patients/new')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          <FiPlus size={18} />
          Thêm Bệnh Nhân
        </button>
      </div>

      {/* Search bar */}
      <div style={{ marginBottom: '20px', position: 'relative', maxWidth: '500px', display: 'flex', alignItems: 'center' }}>
        <FiSearch size={18} style={{ 
          position: 'absolute', 
          left: '14px', 
          color: 'var(--text-sub)',
          pointerEvents: 'none'
        }} />
        <input
          type="text"
          className="search-box"
          placeholder="Tìm kiếm theo tên hoặc số điện thoại..."
          value={searchInput}
          onChange={handleSearch}
          style={{ width: '100%', paddingLeft: '42px', marginBottom: 0 }}
        />
      </div>

      <table className="table">
        <thead>
          <tr>
            <th 
              onClick={() => handleSort('id')} 
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                ID {getSortIcon('id')}
              </div>
            </th>
            <th 
              onClick={() => handleSort('name_id')} 
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                Họ Tên {getSortIcon('name_id')}
              </div>
            </th>
            <th 
              onClick={() => handleSort('phone')} 
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                SĐT {getSortIcon('phone')}
              </div>
            </th>
            <th 
              onClick={() => handleSort('gender')} 
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                Giới Tính {getSortIcon('gender')}
              </div>
            </th>
            <th 
              onClick={() => handleSort('dob')} 
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                Ngày Sinh {getSortIcon('dob')}
              </div>
            </th>
            <th>Đã xử lý lại</th>
            <th>Hành Động</th>
          </tr>
        </thead>
        <tbody>
          {patients.map((patient) => (
            <tr key={patient.id}>
              <td>{patient.id}</td>
              <td>{patient.name}</td>
              <td>{patient.phone}</td>
              <td>{patient.gender === 'male' ? 'Nam' : patient.gender === 'female' ? 'Nữ' : '-'}</td>
              <td>{patient.dob ? new Date(patient.dob).toLocaleDateString('vi-VN') : '-'}</td>
              <td>{getReprocessBadge(parseInt(patient.total_visits) || 0, parseInt(patient.reprocessed_visits) || 0)}</td>
              <td className="action-buttons">
                <button 
                  className="icon-button"
                  onClick={() => navigate(`/patients/${patient.id}/visits`, { state: { previousSearch: '?' + searchParams.toString() } })}
                  title="Xem lần khám"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <FiEye size={16} />
                  Xem
                </button>
                <button 
                  className="icon-button"
                  onClick={() => handleDelete(patient)}
                  disabled={deletingPatientId === patient.id}
                  title="Xóa"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--error)' }}
                >
                  <FiTrash2 size={16} />
                  {deletingPatientId === patient.id ? 'Đang xóa...' : 'Xóa'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {patients.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: '20px', color: '#999' }}>
          {searchQuery ? 'Không tìm thấy bệnh nhân' : 'Không có bệnh nhân nào'}
        </div>
      )}

      {/* Pagination Controls */}
      {total > 0 && (
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          padding: '20px',
          borderTop: '1px solid #ddd'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span>Hiển thị:</span>
            <select value={limit} onChange={handleLimitChange} style={{ padding: '5px' }}>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              {/* <option value={100}>100</option> */}
            </select>
            <span>/ trang</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span>Trang {page} / {totalPages} (Tổng: {total})</span>
            
            <button
              onClick={() => handlePageChange(1)}
              disabled={page === 1}
              className="button-secondary button"
              style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <FiChevronsLeft size={16} />
            </button>
            
            <button
              onClick={() => handlePageChange(page - 1)}
              disabled={page === 1}
              className="button-secondary button"
              style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <FiChevronLeft size={16} />
            </button>

            {/* Page numbers */}
            {[...Array(totalPages)].map((_, i) => {
              const pageNum = i + 1
              // Show first, last, current, and nearby pages
              if (
                pageNum === 1 ||
                pageNum === totalPages ||
                (pageNum >= page - 1 && pageNum <= page + 1)
              ) {
                return (
                  <button
                    key={pageNum}
                    onClick={() => handlePageChange(pageNum)}
                    disabled={pageNum === page}
                    className={pageNum === page ? 'button' : 'button-secondary button'}
                    style={{
                      padding: '8px 12px',
                      minWidth: '40px'
                    }}
                  >
                    {pageNum}
                  </button>
                )
              } else if (
                pageNum === page - 2 ||
                pageNum === page + 2
              ) {
                return <span key={pageNum}>...</span>
              }
              return null
            })}

            <button
              onClick={() => handlePageChange(page + 1)}
              disabled={page === totalPages}
              className="button-secondary button"
              style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <FiChevronRight size={16} />
            </button>
            
            <button
              onClick={() => handlePageChange(totalPages)}
              disabled={page === totalPages}
              className="button-secondary button"
              style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <FiChevronsRight size={16} />
            </button>
          </div>
        </div>
      )}

    </div>
  )
}

export default PatientList
