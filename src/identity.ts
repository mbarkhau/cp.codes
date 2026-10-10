/** Only the edge-populated identity is trusted. X-Real-IP / X-Forwarded-For
 * are user input and must never authorize the uploader or a recipient. */
export function clientIp(request: Request): string | null {
	const ip = request.headers.get('cf-connecting-ip')?.trim();
	if (ip && ip.length <= 64 && /^[0-9a-f.:]+$/i.test(ip)) return ip.toLowerCase();
	const host = new URL(request.url).hostname;
	if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return '127.0.0.1';
	return null;
}
