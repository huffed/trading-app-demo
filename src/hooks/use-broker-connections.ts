"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteBrokerConnection,
  listBrokerConnections,
  saveBrokerConnection,
  syncBrokerConnection,
  type BrokerInput,
} from "@/app/(dashboard)/settings/broker-actions";

const KEY = ["broker-connections"];

export function useBrokerConnections() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const r = await listBrokerConnections();
      if (!r.success) throw new Error(r.error);
      return r.data;
    },
  });
}

export function useSaveBrokerConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BrokerInput) => saveBrokerConnection(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSyncBrokerConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => syncBrokerConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteBrokerConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteBrokerConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
