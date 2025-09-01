document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const aiInput = document.getElementById('ai-input');
    const chatLink = document.getElementById('chat-link');

    // 导航点击事件
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            console.log(`${item.textContent} link clicked`);
        });
    });

    // 标题区域点击事件 - 传递输入数据
    if (chatLink) {
        chatLink.addEventListener('click', (e) => {
            e.preventDefault();
            const message = aiInput ? aiInput.value.trim() : '';
            if (message) {
                sessionStorage.setItem('aiInitialMessage', message);
                if (aiInput) aiInput.value = ''; // 清空输入框
            }
            window.location.href = 'ai-chat.html';
        });
    }

    // 输入框Enter键事件
    if (aiInput) {
        aiInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (chatLink) chatLink.click();
            }
        });
    }
    
    // Simple check for touch devices
    if ('ontouchstart' in window || navigator.maxTouchPoints) {
        document.body.classList.add('touch-device');
    } else {
        document.body.classList.add('no-touch-device');
    }

    // Get the modal
    const modal = document.getElementById('qrModal');

    // Get the image and insert it inside the modal
    const modalImg = document.getElementById('img-zoom');
    const qrImages = document.querySelectorAll('.qr-code-img');

    qrImages.forEach(img => {
        img.onclick = function(){
            modal.style.display = "flex";
            modalImg.src = this.src;
        }
    });

    // Get the <span> element that closes the modal
    const span = document.getElementsByClassName("close")[0];

    // When the user clicks on <span> (x), close the modal
    if (span) {
        span.onclick = function() { 
            modal.style.display = "none";
        }
    }

    // When the user clicks anywhere outside of the modal content, close it
    window.onclick = function(event) {
        if (event.target == modal) {
            modal.style.display = "none";
        }
    }
});