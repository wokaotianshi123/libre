// api.js - 修改后的完整版本
// 逻辑说明：优先加载第2个源，自动遍历所有源嗅探m3u8链接

async function handleApiRequest(url) {
    const customApi = url.searchParams.get('customApi') || '';
    const source = url.searchParams.get('source') || 'heimuer';
    
    try {
        // 1. 搜索处理逻辑
        if (url.pathname === '/api/search') {
            const searchQuery = url.searchParams.get('wd');
            if (!searchQuery) throw new Error('缺少搜索参数');
            
            if (source === 'custom' && !customApi) throw new Error('自定义API地址不能为空');
            if (!API_SITES[source] && source !== 'custom') throw new Error('无效的API来源');
            
            const apiUrl = customApi
                ? `${customApi}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`
                : `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            try {
                const response = await fetch(PROXY_URL + encodeURIComponent(apiUrl), {
                    headers: API_CONFIG.search.headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`API请求失败: ${response.status}`);
                
                const data = await response.json();
                if (!data || !Array.isArray(data.list)) throw new Error('API返回数据格式无效');
                
                data.list.forEach(item => {
                    item.source_name = source === 'custom' ? '自定义源' : API_SITES[source].name;
                    item.source_code = source;
                    if (source === 'custom') item.api_url = customApi;
                });
                
                return JSON.stringify({ code: 200, list: data.list || [] });
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
        }

        // 2. 详情处理逻辑 (包含多源嗅探与切换)
        if (url.pathname === '/api/detail') {
            const id = url.searchParams.get('id');
            const sourceCode = url.searchParams.get('source') || 'heimuer';
            
            if (!id) throw new Error('缺少视频ID参数');
            if (!/^[\w-]+$/.test(id)) throw new Error('无效的视频ID格式');

            // 特殊爬虫源处理
            if (sourceCode !== 'custom' && API_SITES[sourceCode].detail) {
                return await handleSpecialSourceDetail(id, sourceCode);
            }
            
            const detailUrl = customApi
                ? `${customApi}${API_CONFIG.detail.path}${id}`
                : `${API_SITES[sourceCode].api}${API_CONFIG.detail.path}${id}`;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            try {
                const response = await fetch(PROXY_URL + encodeURIComponent(detailUrl), {
                    headers: API_CONFIG.detail.headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`详情请求失败: ${response.status}`);
                
                const data = await response.json();
                if (!data || !data.list || data.list.length === 0) throw new Error('详情内容无效');
                
                const videoDetail = data.list[0];
                let episodes = [];
                
                // --- 核心修改：多源嗅探逻辑 ---
                if (videoDetail.vod_play_url) {
                    const playSources = videoDetail.vod_play_url.split('$$$');
                    
                    // 定义优先级：[索引1 (第2个源), 索引0 (第1个源), 其余源...]
                    let checkOrder = [];
                    if (playSources.length > 1) checkOrder.push(1); // 优先第2个
                    if (playSources.length > 0) checkOrder.push(0); // 其次第1个
                    for (let i = 2; i < playSources.length; i++) {
                        checkOrder.push(i); // 最后其他
                    }

                    let foundValidM3U8 = false;

                    // 遍历所有源进行嗅探
                    for (const idx of checkOrder) {
                        const sourceStr = playSources[idx];
                        const tempEpisodeList = sourceStr.split('#').map(ep => {
                            const parts = ep.split('$');
                            return parts.length > 1 ? parts[1] : parts[0];
                        }).filter(link => link && link.startsWith('http'));

                        // 嗅探：检查该源中是否有任何链接包含 m3u8
                        const hasM3U8 = tempEpisodeList.some(link => link.toLowerCase().includes('.m3u8'));
                        
                        if (hasM3U8) {
                            episodes = tempEpisodeList;
                            foundValidM3U8 = true;
                            console.log(`嗅探成功：已自动切换至播放源索引 ${idx} (包含m3u8)`);
                            break; // 找到即停止切换
                        }
                    }

                    // 如果所有源都没嗅探到 m3u8，兜底使用第一个可用源
                    if (!foundValidM3U8 && episodes.length === 0) {
                        const fallbackSource = playSources[0].split('#');
                        episodes = fallbackSource.map(ep => {
                            const parts = ep.split('$');
                            return parts.length > 1 ? parts[1] : parts[0];
                        }).filter(link => link && link.startsWith('http'));
                    }
                }
                
                // 正则兜底逻辑
                if (episodes.length === 0 && videoDetail.vod_content) {
                    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
                    episodes = matches.map(link => link.replace(/^\$/, ''));
                }
                
                return JSON.stringify({
                    code: 200,
                    episodes: episodes,
                    videoInfo: {
                        title: videoDetail.vod_name,
                        cover: videoDetail.vod_pic,
                        desc: videoDetail.vod_content,
                        source_name: sourceCode === 'custom' ? '自定义源' : API_SITES[sourceCode].name,
                        source_code: sourceCode
                    }
                });
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
        }

        throw new Error('未知的API路径');
    } catch (error) {
        console.error('API处理错误:', error);
        return JSON.stringify({ code: 400, msg: error.message, list: [], episodes: [] });
    }
}

// 处理自定义API的特殊详情页
async function handleCustomApiSpecialDetail(id, customApi) {
    try {
        const detailUrl = `${customApi}/index.php/vod/detail/id/${id}.html`;
        const response = await fetch(PROXY_URL + encodeURIComponent(detailUrl));
        const html = await response.text();
        const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
        let matches = html.match(generalPattern) || [];
        matches = matches.map(link => link.substring(1).split('(')[0]);
        
        return JSON.stringify({
            code: 200,
            episodes: matches,
            videoInfo: { title: '自定义视频', source_name: '自定义源', source_code: 'custom' }
        });
    } catch (error) { throw error; }
}

// 通用特殊源详情处理
async function handleSpecialSourceDetail(id, sourceCode) {
    try {
        const detailUrl = `${API_SITES[sourceCode].detail}/index.php/vod/detail/id/${id}.html`;
        const response = await fetch(PROXY_URL + encodeURIComponent(detailUrl));
        const html = await response.text();
        const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
        let matches = Array.from(new Set(html.match(generalPattern) || []));
        matches = matches.map(link => link.substring(1).split('(')[0]);
        
        return JSON.stringify({
            code: 200,
            episodes: matches,
            videoInfo: { title: '视频详情', source_name: API_SITES[sourceCode].name, source_code: sourceCode }
        });
    } catch (error) { throw error; }
}

// 处理聚合搜索
async function handleAggregatedSearch(searchQuery) {
    const availableSources = Object.keys(API_SITES).filter(key => key !== 'aggregated' && key !== 'custom');
    const searchPromises = availableSources.map(async (source) => {
        try {
            const apiUrl = `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(apiUrl), { signal: AbortSignal.timeout(8000) });
            const data = await response.json();
            return (data.list || []).map(item => ({...item, source_name: API_SITES[source].name, source_code: source}));
        } catch (e) { return []; }
    });
    
    const resultsArray = await Promise.all(searchPromises);
    let allResults = resultsArray.flat();
    const uniqueResults = Array.from(new Map(allResults.map(item => [`${item.source_code}_${item.vod_id}`, item])).values());
    uniqueResults.sort((a, b) => (a.vod_name || '').localeCompare(b.vod_name || ''));
    return JSON.stringify({ code: 200, list: uniqueResults });
}

// 处理多个自定义API源的聚合搜索
async function handleMultipleCustomSearch(searchQuery, customApiUrls) {
    const apiUrls = customApiUrls.split(',').map(url => url.trim()).filter(url => url.startsWith('http')).slice(0, 5);
    const searchPromises = apiUrls.map(async (apiUrl, index) => {
        try {
            const fullUrl = `${apiUrl}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            const response = await fetch(PROXY_URL + encodeURIComponent(fullUrl), { signal: AbortSignal.timeout(8000) });
            const data = await response.json();
            return (data.list || []).map(item => ({...item, source_name: `自定义${index+1}`, source_code: 'custom', api_url: apiUrl}));
        } catch (e) { return []; }
    });
    const resultsArray = await Promise.all(searchPromises);
    return JSON.stringify({ code: 200, list: resultsArray.flat() });
}

// 拦截并接管 API 请求
(function() {
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
        const requestUrl = typeof input === 'string' ? new URL(input, window.location.origin) : new URL(input.url);
        
        if (requestUrl.pathname.startsWith('/api/')) {
            try {
                const data = await handleApiRequest(requestUrl);
                return new Response(data, {
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (error) {
                return new Response(JSON.stringify({ code: 500, msg: 'Internal Server Error' }), { status: 500 });
            }
        }
        return originalFetch.apply(this, arguments);
    };
})();

// 站点可用性测试
async function testSiteAvailability(apiUrl) {
    try {
        const response = await fetch('/api/search?wd=test&customApi=' + encodeURIComponent(apiUrl), {
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) return false;
        const data = await response.json();
        return data && data.code !== 400 && Array.isArray(data.list);
    } catch (error) { return false; }
}