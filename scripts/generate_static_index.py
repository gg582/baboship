import os
import re

def render_template():
    template_path = 'templates/index.html.tmpl'
    output_path = 'dist/index.html'
    
    if not os.path.exists('dist'):
        os.makedirs('dist')

    with open(template_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Define template variables
    variables = {
        'app_name': '바보쉽 라우트 콘솔',
        'hero_pill': 'Global Freight Control',
        'hero_body': '실시간 항로 지표와 통제된 규제를 결합해, 배송 최단 시간 경로를 한 화면에서 설계하세요.'
    }

    # Replace variables
    for key, value in variables.items():
        pattern = re.compile(r'\{\{\s*' + key + r'\s*\}\}')
        content = pattern.sub(value, content)

    # Fix asset paths and script type for static deployment
    content = content.replace('/docs/app.css', 'app.css')
    content = content.replace('<script src="/docs/app.js" defer></script>', '<script src="app.js" type="module" defer></script>')

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Generated {output_path}")

if __name__ == '__main__':
    render_template()
