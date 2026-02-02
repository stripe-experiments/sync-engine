import type { EntitySchema } from './types'


export const couponSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'amount_off',
    'created',
    'currency',
    'duration',
    'duration_in_months',
    'livemode',
    'max_redemptions',
    'metadata',
    'name',
    'percent_off',
    'redeem_by',
    'times_redeemed',
    'valid',
  ],
} as const
