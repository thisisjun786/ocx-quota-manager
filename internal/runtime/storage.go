package runtime

import "fmt"

func storageWarnings(st any) []string {
	reader, ok := st.(interface{ StorageUsage() (int64, int64, error) })
	if !ok {
		return nil
	}
	used, limit, err := reader.StorageUsage()
	if err != nil {
		return []string{"사용 기록 DB의 남은 저장 공간을 확인하지 못했습니다."}
	}
	if limit <= 0 || float64(used)/float64(limit) < 0.8 {
		return nil
	}
	return []string{fmt.Sprintf("사용 기록 DB가 저장 한도의 %.0f%%를 사용 중입니다(%.0f / %.0f MiB). 자동 정리 상태와 저장 한도를 확인하세요.", 100*float64(used)/float64(limit), float64(used)/(1<<20), float64(limit)/(1<<20))}
}
