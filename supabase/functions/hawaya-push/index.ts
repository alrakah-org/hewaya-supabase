// @ts-types="npm:@types/web-push@3.6.4"
import webpush from 'web-push';
import {createPushHandler} from './core.ts';

Deno.serve(createPushHandler({
  url:Deno.env.get('SUPABASE_URL')!,
  serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  gatewayKey:Deno.env.get('SUPABASE_ANON_KEY')!
},webpush));
