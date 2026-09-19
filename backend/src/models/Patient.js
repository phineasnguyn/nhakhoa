const db = require('../config/database');

class Patient {
    static async findAll(options = {}) {
        const { page = 1, limit = 10, search, status, sortBy = 'name_id', sortOrder = 'DESC' } = options;
        const offset = (page - 1) * limit;
        
        let whereConditions = [];
        let params = [];
        let paramIndex = 1;
        
        if (search) {
            whereConditions.push(`(
                p.name ILIKE $${paramIndex} OR 
                p.phone ILIKE $${paramIndex} OR 
                CAST(p.id AS TEXT) ILIKE $${paramIndex} OR 
                COALESCE(p.notes, '') ILIKE $${paramIndex}
            )`);
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        if (status) {
            whereConditions.push(`p.status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }
        
        // Add soft delete filter
        whereConditions.push('p.deleted_at IS NULL');
        
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        // Extract number from name pattern "Bệnh Nhân #XXXX" for sorting
        // Use NULLIF to handle cases where extraction fails, fallback to id
        let orderByClause;
        const allowedSortFields = ['id', 'name', 'name_id', 'phone', 'gender', 'dob', 'created_at'];
        const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'name_id';
        const validSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';
        
        if (validSortBy === 'name_id') {
            orderByClause = `ORDER BY 
                COALESCE(
                    NULLIF(regexp_replace(p.name, '[^0-9]', '', 'g'), '')::integer,
                    p.id
                ) ${validSortOrder}`;
        } else {
            orderByClause = `ORDER BY p.${validSortBy} ${validSortOrder}`;
        }
        
        // Get total count
        const countQuery = `SELECT COUNT(*) FROM patients p ${whereClause}`;
        const countResult = await db.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);
        
        // Get paginated data with visit reprocessing stats
        params.push(limit, offset);
        const dataQuery = `
            SELECT 
                p.*,
                COUNT(v.id)::int as total_visits,
                COUNT(v.id) FILTER (WHERE v.reprocessed_at IS NOT NULL)::int as reprocessed_visits
            FROM patients p
            LEFT JOIN visits v ON v.patient_id = p.id AND v.deleted_at IS NULL
            ${whereClause}
            GROUP BY p.id
            ${orderByClause}
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        const dataResult = await db.query(dataQuery, params);
        
        return {
            data: dataResult.rows,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    static async findById(id) {
        const query = 'SELECT * FROM patients WHERE id = $1 AND deleted_at IS NULL';
        const result = await db.query(query, [id]);
        return result.rows[0];
    }

    static async findByPhone(phone) {
        const query = 'SELECT * FROM patients WHERE phone = $1';
        const result = await db.query(query, [phone]);
        return result.rows;
    }



    static async create(patientData) {
        const { name, phone, dob, gender, notes } = patientData;
        const query = `
            INSERT INTO patients (name, phone, dob, gender, notes)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `;
        const result = await db.query(query, [name, phone, dob, gender, notes]);
        return result.rows[0];
    }

    static async update(id, patientData) {
        const { name, phone, dob, gender, notes } = patientData;
        const query = `
            UPDATE patients 
            SET name = $1, phone = $2, dob = $3, gender = $4, notes = $5, updated_at = CURRENT_TIMESTAMP
            WHERE id = $6
            RETURNING *
        `;
        const result = await db.query(query, [name, phone, dob, gender, notes, id]);
        return result.rows[0];
    }

    static async delete(id) {
        // Soft delete - set deleted_at timestamp
        const query = 'UPDATE patients SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL';
        await db.query(query, [id]);
    }

    static async restore(id) {
        // Restore soft-deleted patient
        const query = 'UPDATE patients SET deleted_at = NULL WHERE id = $1';
        const result = await db.query(query, [id]);
        return result.rowCount > 0;
    }

    static async hardDelete(id) {
        // Permanent delete - use with caution
        const query = 'DELETE FROM patients WHERE id = $1 RETURNING *';
        const result = await db.query(query, [id]);
        return result.rows[0];
    }
}

module.exports = Patient;
