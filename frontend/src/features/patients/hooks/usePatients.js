import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import patientService from '../../services/patientService';
import { QUERY_KEYS } from '../../constants';
import toast from 'react-hot-toast';

/**
 * usePatients Hook
 * Fetch paginated list of patients with React Query
 */
export const usePatients = ({ page, limit, search, sortBy, sortOrder }) => {
  return useQuery({
    queryKey: [...QUERY_KEYS.PATIENTS, { page, limit, search, sortBy, sortOrder }],
    queryFn: () => patientService.getPatients({ page, limit, search, sortBy, sortOrder }),
    keepPreviousData: true,
    staleTime: 30000 // 30 seconds
  });
};

/**
 * usePatient Hook
 * Fetch single patient by ID
 */
export const usePatient = (id) => {
  return useQuery({
    queryKey: QUERY_KEYS.PATIENT(id),
    queryFn: () => patientService.getPatient(id),
    enabled: !!id
  });
};

/**
 * useCreatePatient Hook
 * Create new patient
 */
export const useCreatePatient = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patientData) => patientService.createPatient(patientData),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.PATIENTS });
      toast.success(data.message || 'Tạo bệnh nhân thành công');
    },
    onError: (error) => {
      const message = error.response?.data?.message || 'Có lỗi xảy ra';
      toast.error(message);
    }
  });
};

/**
 * useUpdatePatient Hook
 * Update existing patient
 */
export const useUpdatePatient = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }) => patientService.updatePatient(id, data),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.PATIENTS });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.PATIENT(variables.id) });
      toast.success(data.message || 'Cập nhật bệnh nhân thành công');
    },
    onError: (error) => {
      const message = error.response?.data?.message || 'Có lỗi xảy ra';
      toast.error(message);
    }
  });
};

/**
 * useDeletePatient Hook
 * Permanently delete patient and all related data
 */
export const useDeletePatient = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id) => patientService.deletePatient(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.PATIENTS });
      toast.success(data.message || 'Xóa bệnh nhân thành công');
    },
    onError: (error) => {
      const message = error.response?.data?.message || 'Có lỗi xảy ra';
      toast.error(message);
    }
  });
};
