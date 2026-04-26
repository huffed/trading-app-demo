import { z } from "zod";

export const closePositionSchema = z.object({
  position_id: z.string().uuid("Invalid position ID"),
});
