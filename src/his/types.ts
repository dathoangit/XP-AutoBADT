export interface ClsItem {
  id?: string | number;
  maBieuMau?: string;
  soPhieu?: string | number;
  tenBieuMau?: string;
  api?: string;
  duongDan?: string;
  ketQua?: string;
  fileUrl?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ClsListResponse {
  data?: ClsItem[];
  content?: ClsItem[];
  [key: string]: unknown;
}

export type DescriptorKind = 'xnlis' | 'cls';

export interface FileDescriptor {
  kind: DescriptorKind;
  maBieuMau: string;
  /** soPhieu for XN01, id for others */
  key: string;
  raw: string;
  source: ClsItem;
}
