import os
import re

def render_template():
    template_path = 'templates/index.html.tmpl'
    output_path = 'docs/index.html'
    
    if not os.path.exists('docs'):
        os.makedirs('docs')

    with open(template_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Define template variables
    variables = {
        'app_name': '바보쉽 - 누구나 알 수 있는 직구 택배 위치',
        'hero_pill': '세계 공항·항구 노선 지도',
        'hero_body': '공항끼리 직접 경로를 짜거나, 배로 본 물건이 지나갈 항로도 찾아볼 수 있습니다. 규제로 막힌 노선은 빼고 계산합니다.',
        'tracker_api_base': os.environ.get('TRACKER_API_BASE', 'https://apis.tracker.delivery'),
        'tracker_api_key': os.environ.get('TRACKER_API_KEY', '')
    }

    # Replace variables
    for key, value in variables.items():
        pattern = re.compile(r'\{\{\s*' + key + r'\s*\}\}')
        content = pattern.sub(value, content)

    # Fix asset paths and script type for static deployment in docs/
    content = content.replace('/docs/app.css', 'app.css')
    content = content.replace('<script src="/docs/app.js" defer></script>', '<script src="app.js" type="module" defer></script>')

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Generated {output_path}")

if __name__ == '__main__':
    render_template()
