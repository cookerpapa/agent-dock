public final class divideTest {
    public static void main(String[] args) {
        if (Calculator.divide(21, 3) != 7) throw new AssertionError("divide");
        System.out.println("divide passed");
    }
}
