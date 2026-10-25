import { XN_FORM_CODE } from '../config/env';
import type { ClsItem, FileDescriptor } from './types';

export interface DescriptorSkip {
  index: number;
  item: ClsItem;
  reason: string;
}

export interface DescriptorBuildResult {
  descriptors: FileDescriptor[];
  skipped: DescriptorSkip[];
}

/**
 * Build preview-files descriptors from CLS API items.
 *
 * - XN01 (lab): xnlis<>EMR_BA074.1<>[soPhieu]<>1
 * - others:     cls<>[maBieuMau]<>[id]
 *
 * Items missing required fields are returned in `skipped` (not silently dropped).
 */
export function buildFileDescriptors(items: ClsItem[]): DescriptorBuildResult {
  const descriptors: FileDescriptor[] = [];
  const skipped: DescriptorSkip[] = [];

  for (const [offset, item] of items.entries()) {
    const index = offset + 1;
    const maBieuMau = String(item.maBieuMau ?? '').trim();
    if (!maBieuMau) {
      skipped.push({
        index,
        item,
        reason: 'Thiếu maBieuMau — không tạo được URL preview'
      });
      continue;
    }

    if (maBieuMau === 'XN01') {
      const soPhieu = String(item.soPhieu ?? '').trim();
      if (!soPhieu) {
        skipped.push({
          index,
          item,
          reason: 'XN01 thiếu soPhieu — không tạo được xnlis descriptor'
        });
        continue;
      }

      const raw = `xnlis<>${XN_FORM_CODE}<>${soPhieu}<>1`;
      descriptors.push({
        kind: 'xnlis',
        maBieuMau,
        key: soPhieu,
        raw,
        source: item
      });
      continue;
    }

    const id = String(item.id ?? '').trim();
    if (!id) {
      skipped.push({
        index,
        item,
        reason: `Thiếu id cho maBieuMau=${maBieuMau} — không tạo được cls descriptor`
      });
      continue;
    }

    const raw = `cls<>${maBieuMau}<>${id}`;
    descriptors.push({
      kind: 'cls',
      maBieuMau,
      key: id,
      raw,
      source: item
    });
  }

  return { descriptors, skipped };
}
