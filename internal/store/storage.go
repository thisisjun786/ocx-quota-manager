package store

// StorageUsage excludes reusable free pages from the configured SQLite budget.
func (h *History) StorageUsage() (used, limit int64, err error) {
	var size, pages, free, maxPages int64
	err = h.db.QueryRow(`SELECT s.page_size,c.page_count,f.freelist_count,m.max_page_count
 FROM pragma_page_size() s,pragma_page_count() c,pragma_freelist_count() f,pragma_max_page_count() m`).Scan(&size, &pages, &free, &maxPages)
	if err != nil {
		return 0, 0, err
	}
	return (pages - free) * size, maxPages * size, nil
}
