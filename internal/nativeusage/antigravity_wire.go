package nativeusage

import (
	"encoding/binary"
	"fmt"
	"math"
	"unicode/utf8"
)

// Only decode the wire envelope; bytes fields may contain text rather than messages.
type agField struct {
	wire      uint64
	number    uint64
	bytes     []byte
	duplicate bool
}
type agMessage map[uint64]agField

func agDecode(data []byte) (agMessage, error) {
	fields := make(agMessage)
	for count := 0; len(data) > 0; count++ {
		if count >= 4096 {
			return nil, fmt.Errorf("antigravity: too many protobuf fields")
		}
		key, n := binary.Uvarint(data)
		if n <= 0 || key>>3 == 0 || key>>3 > (1<<29)-1 {
			return nil, fmt.Errorf("antigravity: malformed protobuf tag")
		}
		data = data[n:]
		f := agField{wire: key & 7}
		switch f.wire {
		case 0:
			value, size := binary.Uvarint(data)
			if size <= 0 {
				return nil, fmt.Errorf("antigravity: malformed or overflowing varint")
			}
			f.number, data = value, data[size:]
		case 1, 5:
			size := 8
			if f.wire == 5 {
				size = 4
			}
			if len(data) < size {
				return nil, fmt.Errorf("antigravity: truncated fixed field")
			}
			data = data[size:]
		case 2:
			size, consumed := binary.Uvarint(data)
			if consumed <= 0 || size > uint64(len(data)-consumed) {
				return nil, fmt.Errorf("antigravity: truncated bytes field")
			}
			data = data[consumed:]
			f.bytes, data = data[:int(size)], data[int(size):]
		default:
			return nil, fmt.Errorf("antigravity: unsupported protobuf wire type %d", f.wire)
		}
		_, f.duplicate = fields[key>>3]
		fields[key>>3] = f
	}
	return fields, nil
}

func (m agMessage) field(n, wire uint64) (agField, error) {
	f, ok := m[n]
	if ok && (f.wire != wire || f.duplicate) {
		return agField{}, fmt.Errorf("antigravity: invalid singular field %d", n)
	}
	return f, nil
}
func (m agMessage) message(n uint64) (agMessage, error) {
	f, err := m.field(n, 2)
	if err != nil {
		return nil, err
	}
	return agDecode(f.bytes)
}
func (m agMessage) text(n uint64) (string, error) {
	f, err := m.field(n, 2)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(f.bytes) {
		return "", fmt.Errorf("antigravity: invalid UTF-8 field %d", n)
	}
	return string(f.bytes), nil
}
func (m agMessage) integer(n uint64) (uint64, error) {
	f, err := m.field(n, 0)
	return f.number, err
}
func agTimestamp(m agMessage) (int64, error) {
	seconds, err := m.integer(1)
	if err != nil {
		return 0, err
	}
	nanos, err := m.integer(2)
	if err != nil {
		return 0, err
	}
	if nanos > 999999999 || seconds > uint64((math.MaxInt64-int64(nanos/1000000))/1000) {
		return 0, fmt.Errorf("antigravity: invalid or overflowing timestamp")
	}
	if seconds == 0 {
		return 0, nil
	}
	return int64(seconds)*1000 + int64(nanos/1000000), nil
}
func agTokenSum(m agMessage, fields ...uint64) (int64, error) {
	var total int64
	for _, field := range fields {
		value, err := m.integer(field)
		if err != nil {
			return 0, err
		}
		if value > uint64(MaxTokens-total) {
			return 0, fmt.Errorf("antigravity: token counter overflow")
		}
		total += int64(value)
	}
	return total, nil
}
